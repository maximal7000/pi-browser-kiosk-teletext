import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createStore } from '../src/state.js';
import { createServer } from '../src/server.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'public');
const cleanups = [];
after(async () => { for (const fn of cleanups.reverse()) await fn(); });

function fakeDisplay() {
  const d = new EventEmitter();
  d.reloads = 0;
  d.status = () => ({ connected: true, loading: false, error: null, screen: { width: 1920, height: 1080 } });
  d.reload = async () => { d.reloads += 1; };
  return d;
}

function fakePreview() {
  const p = { added: [], removed: [] };
  p.addViewer = (id, send) => { p.added.push(id); p.send = send; };
  p.removeViewer = (id) => { p.removed.push(id); };
  return p;
}

async function start(opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-anzeige-server-'));
  const store = await createStore({ file: join(dir, 'config.json') });
  const display = fakeDisplay();
  const preview = fakePreview();
  const server = createServer({ store, display, preview, publicDir, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const text = await res.text();
    return { status: res.status, type: res.headers.get('content-type'), body: text ? JSON.parse(text) : null, text };
  };
  return { store, display, preview, server, base, api };
}

function openWs(base, options) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/live', options);
  const messages = [];
  ws.on('message', (data, isBinary) => messages.push(isBinary ? data : JSON.parse(data.toString())));
  cleanups.push(() => ws.terminate());
  return { ws, messages };
}

async function waitFor(fn, label, timeout = 3000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout: ${label}`);
}

test('GET /api/state returns state and display status', async () => {
  const { api } = await start();
  const res = await api('GET', '/api/state');
  assert.equal(res.status, 200);
  assert.equal(res.body.state.black, false);
  assert.deepEqual(res.body.display.screen, { width: 1920, height: 1080 });
});

test('PUT /api/current validates and shows', async () => {
  const { api } = await start();
  let res = await api('PUT', '/api/current', { url: 'ftp://x' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Bitte eine Adresse mit http:// oder https:// eingeben.');
  res = await api('PUT', '/api/current', { pageId: 'nope' });
  assert.equal(res.status, 404);
  res = await api('PUT', '/api/current', { url: 'https://a.de', zoom: 1.5 });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.state.current, { url: 'https://a.de/', zoom: 1.5, pageId: null });
});

test('zoom, black and reload endpoints', async () => {
  const { api, display } = await start();
  assert.equal((await api('PUT', '/api/zoom', { zoom: 2 })).body.state.current.zoom, 2);
  assert.equal((await api('PUT', '/api/zoom', { zoom: 9 })).status, 400);
  assert.equal((await api('PUT', '/api/black', { black: true })).body.state.black, true);
  assert.equal((await api('POST', '/api/reload', {})).status, 204);
  assert.equal(display.reloads, 1);
});

test('page CRUD round-trip', async () => {
  const { api } = await start();
  const created = await api('POST', '/api/pages', { name: 'Wetter', url: 'https://w.de', zoom: 1.1 });
  assert.equal(created.status, 201);
  assert.equal(created.body.page.number, 101);
  const id = created.body.page.id;
  const updated = await api('PUT', `/api/pages/${id}`, { name: 'Wetter Leipzig' });
  assert.equal(updated.body.page.name, 'Wetter Leipzig');
  assert.equal((await api('GET', '/api/pages')).body.pages.length, 1);
  assert.equal((await api('DELETE', `/api/pages/${id}`)).status, 204);
  assert.equal((await api('DELETE', `/api/pages/${id}`)).status, 404);
  assert.equal((await api('GET', '/api/pages')).body.pages.length, 0);
});

test('bad requests and unknown routes', async () => {
  const { api } = await start();
  const bad = await api('PUT', '/api/black', '{nope');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'Ungültige Anfrage.');
  const unknown = await api('GET', '/api/nothing');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, 'Nicht gefunden.');
  const big = await api('POST', '/api/pages', JSON.stringify({ name: 'x'.repeat(20000), url: 'https://a.de' }));
  assert.equal(big.status, 413);
});

test('static files are served without path traversal', async () => {
  const { base } = await start();
  const index = await fetch(base + '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-type'), /text\/html/);
  assert.match(await index.text(), /fixture index/);
  const startPage = await fetch(base + '/start');
  assert.match(await startPage.text(), /fixture start/);
  for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 404, path);
  }
});

test('websocket receives initial state and every change', async () => {
  const { base, api } = await start();
  const { ws, messages } = openWs(base);
  await once(ws, 'open');
  await waitFor(() => messages.length >= 1, 'initial state');
  assert.equal(messages[0].type, 'state');
  assert.equal(messages[0].state.black, false);
  assert.equal(messages[0].display.connected, true);
  await api('PUT', '/api/black', { black: true });
  await waitFor(() => messages.some((m) => m.type === 'state' && m.state.black === true), 'black state');
});

test('display status changes are broadcast', async () => {
  const { base, display } = await start();
  const { ws, messages } = openWs(base);
  await once(ws, 'open');
  await waitFor(() => messages.length >= 1, 'initial');
  display.status = () => ({ connected: false, loading: false, error: null, screen: null });
  display.emit('status', display.status());
  await waitFor(() => messages.some((m) => m.display && m.display.connected === false), 'status broadcast');
});

test('preview on/off maps to viewers, frames are sent as binary', async () => {
  const { base, preview } = await start();
  const { ws, messages } = openWs(base);
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'preview', on: true }));
  await waitFor(() => preview.added.length === 1, 'viewer added');
  preview.send(Buffer.from([0xff, 0xd8, 1, 2]));
  await waitFor(() => messages.some((m) => Buffer.isBuffer(m)), 'binary frame');
  ws.send(JSON.stringify({ type: 'preview', on: false }));
  await waitFor(() => preview.removed.length === 1, 'viewer removed');
  assert.equal(preview.removed[0], preview.added[0]);
});

test('closing the socket removes the viewer', async () => {
  const { base, preview } = await start();
  const { ws } = openWs(base);
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'preview', on: true }));
  await waitFor(() => preview.added.length === 1, 'viewer added');
  ws.close();
  await waitFor(() => preview.removed.length === 1, 'viewer removed on close');
});

test('a client that stops answering pings is dropped', async () => {
  const { base, preview } = await start({ pingInterval: 200 });
  const { ws } = openWs(base, { autoPong: false });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'preview', on: true }));
  await waitFor(() => preview.added.length === 1, 'viewer added');
  await waitFor(() => preview.removed.length === 1, 'viewer dropped', 1500);
});

test('writes require a JSON content type (blocks cross-site form posts)', async () => {
  const { base, store } = await start();
  for (const [method, path] of [['POST', '/api/pages'], ['PUT', '/api/black'], ['POST', '/api/reload']]) {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ name: 'x', url: 'https://a.de', black: true }),
    });
    assert.equal(res.status, 415, `${method} ${path}`);
  }
  assert.equal(store.get().black, false);
  assert.equal(store.get().pages.length, 0);
});
