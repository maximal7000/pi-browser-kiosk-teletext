import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createPreview } from '../src/preview.js';
import { Cdp } from '../src/cdp.js';
import { launchChromium } from './helpers/chromium.js';

const cleanups = [];
after(async () => { for (const fn of cleanups.reverse()) await fn(); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeCdp() {
  const cdp = new EventEmitter();
  cdp.connected = true;
  cdp.calls = [];
  cdp.send = async (method, params) => {
    cdp.calls.push({ method, params });
    if (method === 'Page.getLayoutMetrics') return { cssLayoutViewport: { clientWidth: 1920, clientHeight: 1080 } };
    if (method === 'Page.captureScreenshot') return { data: Buffer.from('seed').toString('base64') };
    return {};
  };
  cdp.count = (method) => cdp.calls.filter((c) => c.method === method).length;
  return cdp;
}

const frame = (n) => ({ data: Buffer.from(`frame${n}`).toString('base64'), sessionId: n, metadata: {} });

test('screencast starts with the first viewer and stops with the last', async () => {
  const cdp = fakeCdp();
  const preview = createPreview({ cdp });
  preview.addViewer('a', () => {});
  preview.addViewer('b', () => {});
  await sleep(10);
  assert.equal(cdp.count('Page.startScreencast'), 1);
  const start = cdp.calls.find((c) => c.method === 'Page.startScreencast');
  assert.deepEqual({ ...start.params, everyNthFrame: undefined }, { format: 'jpeg', quality: 60, maxWidth: 960, everyNthFrame: undefined });
  preview.removeViewer('a');
  await sleep(10);
  assert.equal(cdp.count('Page.stopScreencast'), 0);
  preview.removeViewer('b');
  preview.removeViewer('b');
  await sleep(10);
  assert.equal(cdp.count('Page.stopScreencast'), 1);
  assert.equal(preview.viewerCount(), 0);
});

test('starting the preview sends a seed screenshot that does not resize the screen', async () => {
  const cdp = fakeCdp();
  const preview = createPreview({ cdp });
  const got = [];
  preview.addViewer('a', (buf) => got.push(buf.toString()));
  await sleep(20);
  const shot = cdp.calls.find((c) => c.method === 'Page.captureScreenshot');
  assert.equal(shot.params.format, 'jpeg');
  assert.equal(shot.params.quality, 60);
  // A scaled clip makes a visible Chromium briefly redraw the page shrunk into
  // the top-left corner of the real screen (reproduced under Xvfb).
  assert.equal(shot.params.clip, undefined);
  assert.deepEqual(got, ['seed']);
});

const acks = (cdp) => cdp.calls.filter((c) => c.method === 'Page.screencastFrameAck').map((c) => c.params.sessionId);

test('every frame is acknowledged exactly once', async () => {
  const cdp = fakeCdp();
  const preview = createPreview({ cdp, maxFps: 2 });
  preview.addViewer('a', () => {});
  for (let i = 1; i <= 3; i++) cdp.emit('Page.screencastFrame', frame(i));
  await sleep(600);
  assert.deepEqual(acks(cdp).sort(), [1, 2, 3]);
});

test('a frame inside the throttle window is acknowledged only when it is sent', async () => {
  const cdp = fakeCdp();
  const preview = createPreview({ cdp, maxFps: 2 });
  preview.addViewer('a', () => {});
  cdp.emit('Page.screencastFrame', frame(1));
  cdp.emit('Page.screencastFrame', frame(2));
  await sleep(50);
  // Holding the ack makes Chromium wait instead of encoding frames nobody sees.
  assert.deepEqual(acks(cdp), [1]);
  await sleep(550);
  assert.deepEqual(acks(cdp), [1, 2]);
});

test('frames are throttled with a trailing newest frame', async () => {
  const cdp = fakeCdp();
  const preview = createPreview({ cdp, maxFps: 2 });
  const got = [];
  preview.addViewer('a', (buf) => got.push(buf.toString()));
  for (let i = 1; i <= 10; i++) cdp.emit('Page.screencastFrame', frame(i));
  await sleep(50);
  assert.deepEqual(got, ['frame1']);
  await sleep(550);
  assert.deepEqual(got, ['frame1', 'frame10']);
  assert.ok(preview.lastFrameAt > 0);
});

test('a late viewer receives the last frame immediately', async () => {
  const cdp = fakeCdp();
  const preview = createPreview({ cdp });
  preview.addViewer('a', () => {});
  cdp.emit('Page.screencastFrame', frame(7));
  await sleep(10);
  const got = [];
  preview.addViewer('b', (buf) => got.push(buf.toString()));
  assert.deepEqual(got, ['frame7']);
});

test('screencast restarts after a reconnect while someone watches', async () => {
  const cdp = fakeCdp();
  const preview = createPreview({ cdp });
  preview.addViewer('a', () => {});
  await sleep(10);
  cdp.emit('connected');
  await sleep(10);
  assert.equal(cdp.count('Page.startScreencast'), 2);
  preview.removeViewer('a');
  cdp.emit('connected');
  await sleep(10);
  assert.equal(cdp.count('Page.startScreencast'), 2);
});

test('real Chromium delivers JPEG frames to a viewer', async () => {
  const chromium = await launchChromium();
  cleanups.push(() => chromium.close());
  const cdp = new Cdp({ port: chromium.port });
  cleanups.push(() => cdp.stop());
  cdp.start();
  await once(cdp, 'connected');
  await cdp.send('Page.navigate', { url: 'about:blank' });
  const preview = createPreview({ cdp });
  const first = new Promise((resolve) => preview.addViewer('a', resolve));
  const buf = await Promise.race([first, sleep(5000).then(() => null)]);
  assert.ok(buf, 'no frame within 5 s');
  assert.equal(buf[0], 0xff);
  assert.equal(buf[1], 0xd8);
  preview.removeViewer('a');
});

test('a screencast start refused mid-navigation is retried', async () => {
  const cdp = fakeCdp();
  const send = cdp.send;
  let refusals = 2;
  cdp.send = async (method, params) => {
    if ((method === 'Page.startScreencast' || method === 'Page.captureScreenshot') && refusals-- > 0) {
      cdp.calls.push({ method, params });
      throw new Error(`${method}: Not attached to an active page`);
    }
    return send(method, params);
  };
  const preview = createPreview({ cdp, retryDelay: 50 });
  const got = [];
  preview.addViewer('a', (buf) => got.push(buf.toString()));
  await sleep(300);
  assert.ok(cdp.count('Page.startScreencast') >= 2, 'screencast start retried');
  assert.deepEqual(got, ['seed']);
});

test('boost raises the frame cap for a while, then throttles again', async () => {
  const cdp = fakeCdp();
  const preview = createPreview({ cdp, maxFps: 2, boostFps: 5 });
  const got = [];
  preview.addViewer('a', (buf) => got.push(buf.toString()));
  await sleep(600); // let the seed frame's send slot pass
  got.length = 0;
  preview.boost(700);
  cdp.emit('Page.screencastFrame', frame(1));
  await sleep(250);
  cdp.emit('Page.screencastFrame', frame(2));
  await sleep(10);
  assert.deepEqual(got, ['frame1', 'frame2'], 'both frames sent at once while boosted');
  await sleep(600);
  got.length = 0;
  cdp.emit('Page.screencastFrame', frame(3));
  await sleep(250);
  cdp.emit('Page.screencastFrame', frame(4));
  await sleep(10);
  assert.deepEqual(got, ['frame3'], 'throttled again after the boost window');
});
