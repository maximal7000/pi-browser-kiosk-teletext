// HTTP API, static control panel and the /live WebSocket.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { ValidationError } from './state.js';

const BODY_LIMIT = 16 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new HttpError(413, 'Anfrage ist zu groß.'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > BODY_LIMIT) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolveBody({});
      try {
        const data = JSON.parse(text);
        if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
        resolveBody(data);
      } catch {
        reject(new HttpError(400, 'Ungültige Anfrage.'));
      }
    });
    req.on('error', reject);
  });
}

// Only names that can belong to this Pi: its own host name, localhost and IP literals.
// Anything else is a DNS-rebinding attempt from a foreign website.
export function hostAllowed(hostHeader, hostname) {
  if (!hostHeader) return false;
  let host;
  try {
    host = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[')) return true; // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  const own = String(hostname ?? '').toLowerCase();
  return ['localhost', own, `${own}.local`].includes(host);
}

export function createServer({ store, display, preview, publicDir, pingInterval = 15000, info = () => ({}), hostname = 'anzeige' }) {
  const root = resolve(publicDir);
  const snapshot = () => ({ state: store.get(), display: display.status() });

  const routes = [
    ['GET', /^\/api\/state$/, async () => [200, snapshot()]],
    ['GET', /^\/api\/info$/, async () => [200, info()]],
    ['PUT', /^\/api\/current$/, async (body) => [200, { state: await store.show(body) }]],
    ['PUT', /^\/api\/zoom$/, async (body) => [200, { state: await store.setZoom(body.zoom) }]],
    ['PUT', /^\/api\/black$/, async (body) => [200, { state: await store.setBlack(body.black) }]],
    ['POST', /^\/api\/reload$/, async () => { await display.reload(); return [204]; }],
    ['GET', /^\/api\/pages$/, async () => [200, { pages: store.get().pages }]],
    ['POST', /^\/api\/pages$/, async (body) => [201, { page: await store.addPage(body) }]],
    ['PUT', /^\/api\/pages\/([\w-]+)$/, async (body, id) => [200, { page: await store.updatePage(id, body) }]],
    ['DELETE', /^\/api\/pages\/([\w-]+)$/, async (body, id) => { await store.removePage(id); return [204]; }],
  ];

  async function handleApi(req, res, pathname) {
    try {
      const match = routes
        .map(([method, re, fn]) => ({ method, m: pathname.match(re), fn }))
        .find((r) => r.m && r.method === req.method);
      if (!match) throw new HttpError(404, 'Nicht gefunden.');
      let body = {};
      if (req.method === 'PUT' || req.method === 'POST') {
        // A JSON content type forces a CORS preflight, so other websites cannot post here.
        if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
          throw new HttpError(415, 'Anfrage muss JSON sein.');
        }
        body = await readBody(req);
      }
      const [status, payload] = await match.fn(body, ...match.m.slice(1));
      if (payload === undefined) {
        res.writeHead(status);
        res.end();
      } else {
        sendJson(res, status, payload);
      }
    } catch (err) {
      if (err instanceof ValidationError || err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
      } else {
        console.error(err);
        sendJson(res, 500, { error: 'Interner Fehler.' });
      }
    }
  }

  async function handleStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 404, { error: 'Nicht gefunden.' });
      return;
    }
    let name = pathname === '/' ? '/index.html' : pathname === '/start' ? '/start.html' : pathname;
    try {
      name = decodeURIComponent(name);
    } catch {
      name = '';
    }
    const file = resolve(join(root, name));
    if (!name || !file.startsWith(root + sep)) {
      sendJson(res, 404, { error: 'Nicht gefunden.' });
      return;
    }
    try {
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      sendJson(res, 404, { error: 'Nicht gefunden.' });
    }
  }

  const server = http.createServer((req, res) => {
    let pathname;
    try {
      ({ pathname } = new URL(req.url, 'http://localhost'));
    } catch {
      sendJson(res, 400, { error: 'Ungültige Anfrage.' });
      return;
    }
    if (!hostAllowed(req.headers.host, hostname)) {
      sendJson(res, 403, { error: 'Zugriff verweigert.' });
      return;
    }
    if (pathname.startsWith('/api/')) handleApi(req, res, pathname);
    else handleStatic(req, res, pathname);
  });

  const wss = new WebSocketServer({
    server,
    path: '/live',
    maxPayload: 4096,
    // Browsers allow cross-origin WebSockets, so another website must not watch the screen.
    verifyClient: ({ req }, done) => {
      let ok = hostAllowed(req.headers.host, hostname);
      const origin = req.headers.origin;
      if (ok && origin) {
        try {
          ok = new URL(origin).host === req.headers.host;
        } catch {
          ok = false;
        }
      }
      done(ok, 403, 'Forbidden');
    },
  });
  const clients = new Set();

  function broadcast() {
    const text = JSON.stringify({ type: 'state', ...snapshot() });
    for (const c of clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(text);
  }
  store.on('change', broadcast);
  display.on('status', broadcast);

  wss.on('connection', (ws) => {
    const client = { ws, id: randomUUID(), alive: true, watching: false };
    clients.add(client);
    const unwatch = () => {
      if (client.watching) {
        client.watching = false;
        preview.removeViewer(client.id);
      }
    };
    ws.send(JSON.stringify({ type: 'state', ...snapshot() }));
    ws.on('pong', () => { client.alive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg?.type !== 'preview') return;
      if (msg.on && !client.watching) {
        client.watching = true;
        preview.addViewer(client.id, (buf) => {
          // Skip frames for a panel that cannot keep up instead of queueing them.
          if (ws.readyState === ws.OPEN && ws.bufferedAmount < 2 * 1024 * 1024) ws.send(buf, { binary: true });
        });
      } else if (!msg.on) {
        unwatch();
      }
    });
    const drop = () => {
      unwatch();
      clients.delete(client);
    };
    ws.on('close', drop);
    ws.on('error', drop);
  });

  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, pingInterval);
  server.on('close', () => {
    clearInterval(heartbeat);
    for (const c of clients) c.ws.terminate();
  });

  return server;
}
