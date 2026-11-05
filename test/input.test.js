import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Cdp } from '../src/cdp.js';
import { createInput, validateInput, KEYS } from '../src/input.js';
import { launchChromium, freePort } from './helpers/chromium.js';

const cleanups = [];
after(async () => { for (const fn of cleanups.reverse()) await fn(); });

const PAGE = `<!doctype html><body style="margin:0;height:4000px">
<button id="b" style="position:absolute;left:600px;top:300px;width:200px;height:100px" onclick="window.clicked=true">x</button>
<form id="f" style="position:absolute;left:0;top:0"><input id="t"></form>
<script>document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); window.submitted = true; });</script>
</body>`;

const pages = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(PAGE); });
await new Promise((r) => pages.listen(0, '127.0.0.1', r));
cleanups.push(() => new Promise((r) => pages.close(r)));
const URL_ = `http://127.0.0.1:${pages.address().port}/`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (cdp, expression) =>
  (await cdp.send('Runtime.evaluate', { expression, returnByValue: true })).result.value;

async function setup() {
  const chromium = await launchChromium({ width: 1280, height: 720 });
  cleanups.push(() => chromium.close());
  const cdp = new Cdp({ port: chromium.port, commandTimeout: 5000 });
  cleanups.push(() => cdp.stop());
  cdp.start();
  await once(cdp, 'connected');
  await cdp.send('Page.enable');
  const loaded = once(cdp, 'Page.loadEventFired');
  await cdp.send('Page.navigate', { url: URL_ });
  await loaded;
  return { cdp, input: createInput({ cdp }) };
}

test('validateInput drops malformed messages', () => {
  assert.equal(validateInput({ type: 'input', kind: 'click', x: 1.2, y: 0.5 }), null);
  assert.equal(validateInput({ type: 'input', kind: 'click', x: 'a', y: 0.5 }), null);
  assert.equal(validateInput({ type: 'input', kind: 'click', x: Number.NaN, y: 0.5 }), null);
  assert.equal(validateInput({ type: 'input', kind: 'text', text: 'x'.repeat(2001) }), null);
  assert.equal(validateInput({ type: 'input', kind: 'text', text: '' }), null);
  assert.equal(validateInput({ type: 'input', kind: 'key', key: 'F5' }), null);
  assert.equal(validateInput({ type: 'input', kind: 'nope' }), null);
  assert.equal(validateInput(null), null);
  assert.deepEqual(validateInput({ type: 'input', kind: 'click', x: 0.5, y: 0.25 }), { kind: 'click', x: 0.5, y: 0.25 });
  assert.deepEqual(validateInput({ type: 'input', kind: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: 99999 }), { kind: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: 2000 });
  assert.equal(Object.keys(KEYS).length, 13);
  assert.deepEqual(KEYS.Enter, { code: 'Enter', keyCode: 13 });
});

// Headless windows lose height to window chrome; the kiosk viewport is the full screen.
const viewportY = async (cdp, y) => y / ((await evaluate(cdp, 'innerHeight')) - 1);

test('a click right after connect lands on the button', async () => {
  const { cdp, input } = await setup();
  const y = await viewportY(cdp, 350);
  assert.equal(await input.handle({ type: 'input', kind: 'click', x: 700 / 1279, y }), true);
  assert.equal(await evaluate(cdp, 'window.clicked === true'), true);
});

test('a click still lands on the button with CSS zoom 2', async () => {
  const { cdp, input } = await setup();
  await evaluate(cdp, `document.documentElement.style.zoom = '2';
    const b = document.getElementById('b'); b.style.left = '300px'; b.style.top = '150px'; b.style.width = '100px'; b.style.height = '50px'; true`);
  await sleep(100);
  await input.handle({ type: 'input', kind: 'click', x: 700 / 1279, y: await viewportY(cdp, 350) });
  assert.equal(await evaluate(cdp, 'window.clicked === true'), true);
});

test('wheel scrolls the page', async () => {
  const { cdp, input } = await setup();
  await input.handle({ type: 'input', kind: 'wheel', x: 0.5, y: 0.5, dx: 0, dy: 600 });
  let y = 0;
  for (let i = 0; i < 20 && y === 0; i++) { await sleep(50); y = await evaluate(cdp, 'scrollY'); }
  assert.ok(y > 0, `scrollY ${y}`);
});

test('text, Backspace and Enter reach the focused field', async () => {
  const { cdp, input } = await setup();
  await evaluate(cdp, 'document.getElementById("t").focus(); true');
  await input.handle({ type: 'input', kind: 'text', text: 'hallo' });
  assert.equal(await evaluate(cdp, 'document.getElementById("t").value'), 'hallo');
  await input.handle({ type: 'input', kind: 'key', key: 'Backspace' });
  assert.equal(await evaluate(cdp, 'document.getElementById("t").value'), 'hall');
  await input.handle({ type: 'input', kind: 'key', key: 'Enter' });
  assert.equal(await evaluate(cdp, 'window.submitted === true'), true);
});

test('input while Chromium is not connected is dropped quietly', async () => {
  const cdp = new Cdp({ port: await freePort() });
  const input = createInput({ cdp });
  assert.equal(await input.handle({ type: 'input', kind: 'click', x: 0.5, y: 0.5 }), false);
  assert.equal(await input.handle({ type: 'input', kind: 'text', text: 'x' }), false);
});
