// Launches a headless Chromium with a DevTools port for integration tests.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

export function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  return require('playwright').chromium.executablePath();
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Chromium only writes DevToolsActivePort when it picks the port itself.
async function waitForHttp(port, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return port;
    } catch {}
    await sleep(50);
  }
  throw new Error(`Chromium did not open port ${port}`);
}

async function waitForPortFile(dir, timeoutMs = 15000) {
  const file = join(dir, 'DevToolsActivePort');
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const text = await readFile(file, 'utf8');
      const port = Number(text.split('\n')[0]);
      if (port) return port;
    } catch {}
    await sleep(50);
  }
  throw new Error('Chromium did not report a DevTools port');
}

export async function launchChromium({ width = 1280, height = 720, port = 0, scrollbars = false } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pi-anzeige-chromium-'));
  let proc;
  let activePort = port;

  async function start() {
    for (const f of ['DevToolsActivePort', 'SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      await rm(join(dataDir, f), { force: true });
    }
    proc = spawn(chromiumPath(), [
      '--headless=new',
      `--remote-debugging-port=${activePort}`,
      `--user-data-dir=${dataDir}`,
      `--window-size=${width},${height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-background-networking',
      '--disable-component-update',
      ...(scrollbars ? [] : ['--hide-scrollbars']),
      'about:blank',
    ], { stdio: 'ignore' });
    activePort = activePort ? await waitForHttp(activePort) : await waitForPortFile(dataDir);
  }

  async function kill() {
    if (!proc || proc.exitCode !== null) return;
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill('SIGKILL');
    await exited;
  }

  await start();
  return {
    get port() { return activePort; },
    kill,
    async restart() { await kill(); await start(); },
    async close() { await kill(); await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}); },
  };
}
