import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createStore } from '../src/state.js';
import { createServer } from '../src/server.js';
import { chromiumPath } from './helpers/chromium.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const FRAME = await readFile(join(here, 'fixtures', 'frame.jpg'));

let browser;
const cleanups = [];
before(async () => { browser = await chromium.launch({ executablePath: chromiumPath() }); });
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
  await browser.close();
});

async function start({ pages = [], frameEvery = 0, screen = { width: 1920, height: 1080 } } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-anzeige-ui-'));
  const store = await createStore({ file: join(dir, 'config.json') });
  for (const p of pages) await store.addPage(p);
  const display = new EventEmitter();
  display.status = () => ({ connected: true, loading: false, error: null, screen });
  display.reload = async () => {};
  const preview = { added: [], removed: [] };
  const timers = new Map();
  preview.addViewer = (id, send) => {
    preview.added.push(id);
    send(FRAME);
    if (frameEvery) timers.set(id, setInterval(() => send(FRAME), frameEvery));
  };
  preview.removeViewer = (id) => { preview.removed.push(id); clearInterval(timers.get(id)); };
  cleanups.push(() => { for (const t of timers.values()) clearInterval(t); });
  preview.boost = () => {};
  const input = { messages: [], handle: async (msg) => { input.messages.push(msg); return true; } };
  const server = createServer({
    store, display, preview, input, publicDir: join(here, '..', 'public'),
    info: () => ({ hostname: 'anzeige', addresses: ['192.168.1.20'] }),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { store, display, preview, input, base: `http://127.0.0.1:${server.address().port}` };
}

async function openPanel(base, viewport = { width: 1440, height: 900 }) {
  const context = await browser.newContext({ viewport });
  context.setDefaultTimeout(5000);
  cleanups.push(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base + '/');
  await page.waitForSelector('#index');
  return { page, errors };
}

const TWO_PAGES = [
  { name: 'Home Assistant', url: 'http://ha.local:8123/', zoom: 1.1 },
  { name: 'Wetter', url: 'https://wetter.example/', zoom: 1 },
];

test('loads cleanly, lists pages and shows the preview frame', async () => {
  const { base, preview } = await start({ pages: TWO_PAGES });
  const { page, errors } = await openPanel(base);
  await page.waitForFunction(() => document.querySelectorAll('#index .row').length === 2);
  await page.waitForFunction(() => document.querySelector('#frameImg')?.naturalWidth === 160);
  assert.equal(preview.added.length, 1);
  assert.equal(await page.textContent('#pnum'), 'P---');
  assert.equal(await page.textContent('#conn'), 'VERBUNDEN');
  assert.deepEqual(errors, []);
});

test('typing a page number switches to that page', async () => {
  const { base, store } = await start({ pages: TWO_PAGES });
  const { page } = await openPanel(base);
  await page.keyboard.type('102');
  await page.waitForFunction(() => document.querySelector('[data-number="102"]')?.getAttribute('aria-current') === 'true');
  assert.equal(store.get().current.url, 'https://wetter.example/');
  assert.equal(await page.textContent('#pnum'), 'P102');
});

test('B toggles black', async () => {
  const { base, store } = await start();
  const { page } = await openPanel(base);
  await page.keyboard.press('b');
  await page.waitForFunction(() => document.querySelector('#kBlack').getAttribute('aria-pressed') === 'true');
  assert.equal(store.get().black, true);
  assert.match(await page.textContent('#kBlack'), /LICHT AN/);
  await page.keyboard.press('b');
  await page.waitForFunction(() => document.querySelector('#kBlack').getAttribute('aria-pressed') === 'false');
});

test('an invalid url shows the German error next to the field', async () => {
  const { base } = await start();
  const { page } = await openPanel(base);
  await page.fill('#url', 'ftp://nope');
  await page.click('#urlForm button[type=submit]');
  await page.waitForSelector('#urlErr:not([hidden])');
  assert.equal(await page.textContent('#urlErr'), 'Bitte eine Adresse mit http:// oder https:// eingeben.');
});

test('empty state explains how to add the first page', async () => {
  const { base } = await start();
  const { page } = await openPanel(base);
  assert.match(await page.textContent('#index'), /Noch keine Seiten/);
});

test('create, edit and delete a page', async () => {
  const { base, store } = await start();
  const { page } = await openPanel(base);
  await page.fill('#url', 'https://bahn.example/abfahrt');
  await page.click('#urlForm button[type=submit]');
  await page.waitForFunction(() => document.querySelector('#nowUrl').textContent.includes('bahn.example'));
  await page.click('#kSave');
  await page.fill('#formName', 'Abfahrten');
  assert.match(await page.textContent('#formSave'), /Als 101 speichern/);
  await page.click('#formSave');
  await page.waitForFunction(() => document.querySelectorAll('#index .row').length === 1);
  assert.equal(store.get().pages[0].name, 'Abfahrten');

  await page.click('[data-edit]');
  await page.fill('#formName', 'Abfahrten Hbf');
  await page.click('#formSave');
  await page.waitForFunction(() => document.querySelector('#index').textContent.includes('Abfahrten Hbf'));

  await page.click('[data-edit]');
  await page.click('#formDelete');
  await page.click('#formDeleteYes');
  await page.waitForFunction(() => document.querySelector('#index').textContent.includes('Noch keine Seiten'));
  assert.equal(store.get().pages.length, 0);
});

test('pausing the preview stops watching', async () => {
  const { base, preview } = await start();
  const { page } = await openPanel(base);
  await page.waitForFunction(() => document.querySelector('#frameImg')?.naturalWidth === 160);
  await page.click('#pauseBtn');
  await page.waitForFunction(() => document.querySelector('#live').textContent.includes('PAUSIERT'));
  for (let i = 0; i < 20 && preview.removed.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(preview.removed.length, 1);
});

test('changes from another panel update this one and flag the row', async () => {
  const { base } = await start({ pages: TWO_PAGES });
  const one = await openPanel(base);
  const two = await openPanel(base);
  await two.page.keyboard.type('101');
  await one.page.waitForFunction(() => document.querySelector('[data-number="101"]')?.classList.contains('flag'));
  await two.page.keyboard.press('b');
  await one.page.waitForFunction(() => document.querySelector('#kBlack').getAttribute('aria-pressed') === 'true');
  // the panel that made the change does not flag its own action
  assert.equal(await two.page.evaluate(() => document.querySelector('[data-number="101"]').classList.contains('flag')), false);
});

test('no horizontal scroll at phone width', async () => {
  const { base } = await start({ pages: TWO_PAGES });
  const { page } = await openPanel(base, { width: 390, height: 844 });
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(width <= 390, `scrollWidth ${width}`);
});

test('start page shows how to reach the control panel', async () => {
  const { base } = await start();
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  context.setDefaultTimeout(5000);
  cleanups.push(() => context.close());
  const page = await context.newPage();
  await page.goto(base + '/start');
  await page.waitForFunction(() => document.body.textContent.includes('192.168.1.20'));
  assert.match(await page.textContent('body'), /http:\/\/anzeige\.local/);
});

test('live frames do not steal keyboard focus from the page list', async () => {
  const { base } = await start({ pages: TWO_PAGES, frameEvery: 100 });
  const { page } = await openPanel(base);
  await page.waitForFunction(() => document.querySelectorAll('#index .row').length === 2);
  await page.focus('[data-number="102"]');
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset?.number), '102');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('[data-number="102"]')?.getAttribute('aria-current') === 'true');
});

async function frameBox(page) {
  await page.waitForFunction(() => document.querySelector('#frameImg')?.naturalWidth === 160);
  return page.locator('#frame').boundingBox();
}

async function until(fn, label) {
  for (let i = 0; i < 50; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 40)); }
  throw new Error(`timeout: ${label}`);
}

test('clicking the live image sends normalized coordinates', async () => {
  const { base, input } = await start();
  const { page } = await openPanel(base);
  const box = await frameBox(page);
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.75);
  await until(() => input.messages.length === 1, 'click message');
  const m = input.messages[0];
  assert.equal(m.kind, 'click');
  assert.ok(Math.abs(m.x - 0.25) < 0.02, `x ${m.x}`);
  assert.ok(Math.abs(m.y - 0.75) < 0.02, `y ${m.y}`);
});

test('clicks on the letterbox bars are ignored', async () => {
  const { base, input } = await start({ screen: { width: 1080, height: 1920 } });
  const { page } = await openPanel(base);
  const box = await frameBox(page);
  // portrait screen box, landscape frame image: bars above and below the image
  const frame = page.locator('#frame');
  await frame.click({ position: { x: box.width / 2, y: box.height * 0.03 } });
  await frame.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await until(() => input.messages.length === 1, 'one click');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(input.messages.length, 1);
  assert.ok(Math.abs(input.messages[0].y - 0.5) < 0.02);
});

test('typing into the focused live image goes to the Pi, not to shortcuts', async () => {
  const { base, input, store } = await start({ pages: TWO_PAGES });
  const { page } = await openPanel(base);
  const box = await frameBox(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForSelector('#frameHint', { state: 'visible' });
  await page.keyboard.type('b1');
  await page.keyboard.press('Enter');
  await until(() => input.messages.length === 4, 'click + 3 key messages');
  assert.deepEqual(input.messages.slice(1), [
    { type: 'input', kind: 'text', text: 'b' },
    { type: 'input', kind: 'text', text: '1' },
    { type: 'input', kind: 'key', key: 'Enter' },
  ]);
  assert.equal(store.get().black, false);
  assert.equal(await page.textContent('#pnum'), 'P---');
});

test('shortcuts work again after leaving the live image', async () => {
  const { base, store } = await start();
  const { page } = await openPanel(base);
  const box = await frameBox(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.click('#urlH');
  await page.keyboard.press('b');
  await page.waitForFunction(() => document.querySelector('#kBlack').getAttribute('aria-pressed') === 'true');
  assert.equal(store.get().black, true);
});

test('AltGr characters like @ are typed on the Pi', async () => {
  const { base, input } = await start();
  const { page } = await openPanel(base);
  const box = await frameBox(page);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.evaluate(() => {
    const f = document.getElementById('frame');
    f.dispatchEvent(new KeyboardEvent('keydown', { key: '@', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }));
    f.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }));
  });
  await until(() => input.messages.length >= 2, 'click + @');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(input.messages.slice(1), [{ type: 'input', kind: 'text', text: '@' }]);
});

test('the mouse wheel only scrolls the Pi once the live image is focused', async () => {
  const { base, input } = await start();
  const { page } = await openPanel(base);
  const box = await frameBox(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(input.messages.length, 0, 'wheel over an unfocused preview stays with the panel');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 200);
  await until(() => input.messages.some((m) => m.kind === 'wheel'), 'wheel after focus');
});
