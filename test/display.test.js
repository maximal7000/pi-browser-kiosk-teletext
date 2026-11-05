import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { createServer } from 'node:http';
import { Cdp } from '../src/cdp.js';
import { createStore } from '../src/state.js';
import { createDisplay, zoomMetrics } from '../src/display.js';
import { launchChromium, freePort } from './helpers/chromium.js';

const cleanups = [];
after(async () => { for (const fn of cleanups.reverse()) await fn(); });

// Local pages to display; the store only accepts http(s) urls.
const pages = createServer((req, res) => {
  const text = req.url.slice(1) || 'start';
  res.setHeader('Content-Type', 'text/html');
  res.end(`<body style="margin:0;background:#fff">${text}</body>`);
});
await new Promise((r) => pages.listen(0, '127.0.0.1', r));
cleanups.push(() => new Promise((r) => pages.close(r)));
const base = `http://127.0.0.1:${pages.address().port}`;
const WHITE = `${base}/white`;
const OTHER = `${base}/other`;
const START = `${base}/start`;

async function waitFor(fn, { timeout = 15000, label = 'condition' } = {}) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) { last = err; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${label} (last: ${last})`);
}

async function setup({ port, retryDelays } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-anzeige-display-'));
  const store = await createStore({ file: join(dir, 'config.json') });
  let chromium = null;
  if (!port) {
    chromium = await launchChromium({ width: 1280, height: 720 });
    cleanups.push(() => chromium.close());
    port = chromium.port;
  }
  const cdp = new Cdp({ port, minBackoff: 100, maxBackoff: 300 });
  cleanups.push(() => cdp.stop());
  const display = createDisplay({ cdp, store, startUrl: START, retryDelays });
  cdp.start();
  return { store, cdp, display, port };
}

const evaluate = async (cdp, expression) =>
  (await cdp.send('Runtime.evaluate', { expression, returnByValue: true })).result.value;

// Reads the RGB of the pixel at (x, y) from a 1×1 PNG screenshot.
async function pixel(cdp, x, y) {
  const { data } = await cdp.send('Page.captureScreenshot', {
    format: 'png', clip: { x, y, width: 1, height: 1, scale: 1 },
  });
  const png = Buffer.from(data, 'base64');
  const idat = [];
  let off = 8;
  while (off < png.length) {
    const len = png.readUInt32BE(off);
    const type = png.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  // First pixel of the first row: every PNG filter reduces to the raw value here.
  return [raw[1], raw[2], raw[3]];
}

test('zoomMetrics divides the viewport by the zoom factor', () => {
  assert.deepEqual(zoomMetrics({ width: 1920, height: 1080 }, 1.5), {
    width: 1280, height: 720, deviceScaleFactor: 1.5, mobile: false,
  });
});

test('shows the start url, then the url from the store', async () => {
  const { store, cdp, display } = await setup();
  await waitFor(() => display.status().connected, { label: 'connected' });
  await waitFor(async () => (await evaluate(cdp, 'location.href')) === START, { label: 'start url' });
  await store.show({ url: WHITE });
  await waitFor(async () => (await evaluate(cdp, 'document.body.textContent')) === 'white', { label: 'white page' });
  assert.deepEqual(display.status().screen, { width: 1280, height: 720 });
});

test('zoom 2 halves the css viewport width', async () => {
  const { store, cdp, display } = await setup();
  await waitFor(() => display.status().connected, { label: 'connected' });
  await store.show({ url: WHITE, zoom: 2 });
  await waitFor(async () => Math.abs((await evaluate(cdp, 'innerWidth')) - 640) <= 1, { label: 'innerWidth 640' });
  await store.setZoom(1);
  await waitFor(async () => Math.abs((await evaluate(cdp, 'innerWidth')) - 1280) <= 1, { label: 'innerWidth 1280' });
});

test('black covers the page, survives navigation and can be removed', async () => {
  const { store, cdp, display } = await setup();
  await waitFor(() => display.status().connected, { label: 'connected' });
  await store.show({ url: WHITE });
  await waitFor(async () => (await evaluate(cdp, 'document.body.textContent')) === 'white', { label: 'white page' });
  assert.deepEqual(await pixel(cdp, 640, 360), [255, 255, 255]);

  await store.setBlack(true);
  await waitFor(async () => (await pixel(cdp, 640, 360)).every((v) => v < 10), { label: 'black pixel' });

  await store.show({ url: OTHER });
  await waitFor(async () => (await evaluate(cdp, 'document.body.textContent')) === 'other', { label: 'other page' });
  await waitFor(async () => (await evaluate(cdp, '!!document.getElementById("__pi_anzeige_black")')) === true, { label: 'overlay after navigation' });
  assert.ok((await pixel(cdp, 640, 360)).every((v) => v < 10));

  await store.setBlack(false);
  await waitFor(async () => (await evaluate(cdp, '!document.getElementById("__pi_anzeige_black")')) === true, { label: 'overlay removed' });
  assert.deepEqual(await pixel(cdp, 640, 360), [255, 255, 255]);
});

test('applies the stored state once a late Chromium appears', async () => {
  const port = await freePort();
  const { store, cdp, display } = await setup({ port });
  await store.show({ url: WHITE });
  assert.equal(display.status().connected, false);
  const chromium = await launchChromium({ port });
  cleanups.push(() => chromium.close());
  await waitFor(() => display.status().connected, { label: 'connected' });
  await waitFor(async () => (await evaluate(cdp, 'document.body.textContent')) === 'white', { label: 'white page' });
});

test('an unreachable page sets an error and is retried', async () => {
  const { store, cdp, display } = await setup({ retryDelays: [200] });
  await waitFor(() => display.status().connected, { label: 'connected' });
  const navigations = [];
  const send = cdp.send.bind(cdp);
  cdp.send = (method, params) => {
    if (method === 'Page.navigate') navigations.push(params.url);
    return send(method, params);
  };
  await store.show({ url: 'http://127.0.0.1:9/' });
  await waitFor(() => display.status().error === 'Seite nicht erreichbar', { label: 'error status' });
  await waitFor(() => navigations.filter((u) => u === 'http://127.0.0.1:9/').length >= 2, { label: 'retry' });
  await store.show({ url: WHITE });
  await waitFor(() => display.status().error === null, { label: 'error cleared' });
});
