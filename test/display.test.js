import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { createServer } from 'node:http';
import { Cdp } from '../src/cdp.js';
import { createStore } from '../src/state.js';
import { createDisplay } from '../src/display.js';
import { launchChromium, freePort } from './helpers/chromium.js';

const cleanups = [];
after(async () => { for (const fn of cleanups.reverse()) await fn(); });

// Local pages to display; the store only accepts http(s) urls.
const special = {
  '/half': '<body style="margin:0;background:#fff"><div style="width:640px;height:100vh;background:#f00"></div></body>',
  '/framed': '<body style="margin:0;background:#fff"><iframe src="/white" style="border:0;width:100vw;height:100vh;display:block"></iframe></body>',
  '/alert': '<body style="margin:0;background:#fff">alert<script>alert("hi")</script></body>',
};
const pages = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  if (special[req.url]) return res.end(special[req.url]);
  const text = req.url.slice(1) || 'start';
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
  // Short command timeout: a screenshot taken mid-navigation hangs in headless Chromium.
  const cdp = new Cdp({ port, minBackoff: 100, maxBackoff: 300, commandTimeout: 3000 });
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

test('shows the start url, then the url from the store', async () => {
  const { store, cdp, display } = await setup();
  await waitFor(() => display.status().connected, { label: 'connected' });
  await waitFor(async () => (await evaluate(cdp, 'location.href')) === START, { label: 'start url' });
  await store.show({ url: WHITE });
  await waitFor(async () => (await evaluate(cdp, 'document.body.textContent')) === 'white', { label: 'white page' });
  assert.deepEqual(display.status().screen, { width: 1280, height: 720 });
});

test('zoom scales the page on the real screen and survives navigation', async () => {
  const { store, cdp, display } = await setup();
  await waitFor(() => display.status().connected, { label: 'connected' });
  // A 640 px red bar fills the whole 1280 px window only when zoom 2 really applies.
  await store.show({ url: `${base}/half`, zoom: 2 });
  await waitFor(async () => (await evaluate(cdp, 'document.readyState === "complete" && !!document.querySelector("div")')) === true, { label: 'half loaded' });
  await waitFor(async () => (await pixel(cdp, 1000, 360))[0] > 200 && (await pixel(cdp, 1000, 360))[1] < 50, { label: 'red at x=1000' });
  await store.setZoom(1);
  await waitFor(async () => (await pixel(cdp, 1000, 360)).every((v) => v > 240), { label: 'white at x=1000' });
  await store.setZoom(2);
  await store.show({ url: OTHER, zoom: 2 });
  await waitFor(async () => (await evaluate(cdp, 'document.body.textContent')) === 'other', { label: 'other page' });
  await store.show({ url: `${base}/half`, zoom: 2 });
  await waitFor(async () => (await evaluate(cdp, 'document.readyState === "complete" && !!document.querySelector("div")')) === true, { label: 'half loaded again' });
  await waitFor(async () => (await pixel(cdp, 1000, 360))[0] > 200 && (await pixel(cdp, 1000, 360))[1] < 50, { label: 'red after navigation' });
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

test('turning black off also clears iframes', async () => {
  const { store, cdp, display } = await setup();
  await waitFor(() => display.status().connected, { label: 'connected' });
  await store.setBlack(true);
  await store.show({ url: `${base}/framed` });
  await waitFor(async () => (await evaluate(cdp, 'document.querySelector("iframe")?.contentDocument?.body?.textContent')) === 'white', { label: 'iframe loaded' });
  await store.setBlack(false);
  await waitFor(async () => (await pixel(cdp, 640, 360)).every((v) => v > 240), { label: 'iframe visible again' });
});

test('a page dialog does not block further control', async () => {
  const { store, cdp, display } = await setup();
  await waitFor(() => display.status().connected, { label: 'connected' });
  await store.show({ url: `${base}/alert` });
  await new Promise((r) => setTimeout(r, 300));
  await store.show({ url: WHITE });
  await waitFor(async () => (await evaluate(cdp, 'document.body.textContent')) === 'white', { label: 'white after alert', timeout: 8000 });
});

test('a crashed page is reloaded', async () => {
  const { store, cdp, display } = await setup();
  await waitFor(() => display.status().connected, { label: 'connected' });
  await store.show({ url: WHITE });
  await waitFor(async () => (await evaluate(cdp, 'document.body.textContent')) === 'white', { label: 'white' });
  cdp.send('Page.crash').catch(() => {});
  await waitFor(async () => (await evaluate(cdp, 'document.body.textContent')) === 'white', { label: 'white after crash', timeout: 10000 });
});

test('choosing the shown page again brings it back after the site navigated away', async () => {
  const { store, cdp, display } = await setup();
  await waitFor(() => display.status().connected, { label: 'connected' });
  const page = await store.addPage({ name: 'W', url: WHITE });
  await store.show({ pageId: page.id });
  await waitFor(async () => (await evaluate(cdp, 'document.body.textContent')) === 'white', { label: 'white' });
  await evaluate(cdp, `location.href = ${JSON.stringify(OTHER)}`);
  await waitFor(async () => (await evaluate(cdp, 'document.body.textContent')) === 'other', { label: 'site navigated away' });
  await store.show({ pageId: page.id });
  await waitFor(async () => (await evaluate(cdp, 'document.body.textContent')) === 'white', { label: 'back to white' });
});

test('the mouse cursor is hidden on every shown page, also after navigation', async () => {
  const { store, cdp, display } = await setup();
  await waitFor(() => display.status().connected, { label: 'connected' });
  await store.show({ url: WHITE });
  await waitFor(async () => (await evaluate(cdp, 'document.body.textContent')) === 'white', { label: 'white' });
  await waitFor(async () => (await evaluate(cdp, 'getComputedStyle(document.body).cursor')) === 'none', { label: 'cursor hidden' });
  await store.show({ url: OTHER });
  await waitFor(async () => (await evaluate(cdp, 'document.body.textContent')) === 'other', { label: 'other' });
  await waitFor(async () => (await evaluate(cdp, 'getComputedStyle(document.body).cursor')) === 'none', { label: 'cursor hidden after navigation' });
});
