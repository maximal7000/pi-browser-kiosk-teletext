#!/usr/bin/env node
// Entry point: wires state, Chromium control, preview and the web server.
import { hostname, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp } from '../src/cdp.js';
import { createStore } from '../src/state.js';
import { createDisplay } from '../src/display.js';
import { createPreview } from '../src/preview.js';
import { createServer } from '../src/server.js';

const PORT = Number(process.env.PORT ?? 80);
const DATA = process.env.PI_ANZEIGE_DATA ?? '/var/lib/pi-anzeige/config.json';
const CDP_HOST = process.env.CDP_HOST ?? '127.0.0.1';
const CDP_PORT = Number(process.env.CDP_PORT ?? 9222);
const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

function info() {
  const addresses = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
  return { hostname: hostname(), addresses };
}

const store = await createStore({ file: DATA });
const cdp = new Cdp({ host: CDP_HOST, port: CDP_PORT });
const display = createDisplay({ cdp, store, startUrl: `http://127.0.0.1:${PORT}/start` });
const preview = createPreview({ cdp });
const server = createServer({ store, display, preview, publicDir, info, hostname: hostname() });

cdp.on('connected', () => console.log('chromium connected'));
cdp.on('disconnected', () => console.log('chromium disconnected, reconnecting'));

server.listen(PORT, () => console.log(`Pi-Anzeige listening on :${PORT}`));
cdp.start();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    await cdp.stop();
    process.exit(0);
  });
}
