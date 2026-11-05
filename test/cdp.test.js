import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Cdp } from '../src/cdp.js';
import { launchChromium, freePort } from './helpers/chromium.js';

const cleanups = [];
after(async () => { for (const fn of cleanups.reverse()) await fn(); });

function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout: ${label}`)), ms))]);
}

test('connects and evaluates JavaScript', async () => {
  const chromium = await launchChromium();
  cleanups.push(() => chromium.close());
  const cdp = new Cdp({ port: chromium.port });
  cleanups.push(() => cdp.stop());
  cdp.start();
  await withTimeout(once(cdp, 'connected'), 10000, 'connected');
  assert.equal(cdp.connected, true);
  const res = await cdp.send('Runtime.evaluate', { expression: '1+1', returnByValue: true });
  assert.equal(res.result.value, 2);
});

test('send rejects while disconnected', async () => {
  const cdp = new Cdp({ port: await freePort() });
  await assert.rejects(cdp.send('Runtime.evaluate', { expression: '1' }), { message: 'not connected' });
});

test('protocol errors reject with the CDP message', async () => {
  const chromium = await launchChromium();
  cleanups.push(() => chromium.close());
  const cdp = new Cdp({ port: chromium.port });
  cleanups.push(() => cdp.stop());
  cdp.start();
  await withTimeout(once(cdp, 'connected'), 10000, 'connected');
  await assert.rejects(cdp.send('No.suchMethod'), /wasn't found|not found/i);
});

test('re-emits CDP events under their method name', async () => {
  const chromium = await launchChromium();
  cleanups.push(() => chromium.close());
  const cdp = new Cdp({ port: chromium.port });
  cleanups.push(() => cdp.stop());
  cdp.start();
  await withTimeout(once(cdp, 'connected'), 10000, 'connected');
  await cdp.send('Page.enable');
  const loaded = once(cdp, 'Page.loadEventFired');
  await cdp.send('Page.navigate', { url: 'data:text/html,<p>hi</p>' });
  await withTimeout(loaded, 10000, 'loadEventFired');
});

test('reconnects after Chromium restarts', async () => {
  const chromium = await launchChromium();
  cleanups.push(() => chromium.close());
  const cdp = new Cdp({ port: chromium.port, minBackoff: 100, maxBackoff: 500 });
  cleanups.push(() => cdp.stop());
  cdp.start();
  await withTimeout(once(cdp, 'connected'), 10000, 'first connect');
  const dropped = once(cdp, 'disconnected');
  await chromium.restart();
  await withTimeout(dropped, 10000, 'disconnected');
  await withTimeout(once(cdp, 'connected'), 15000, 'reconnected');
  const res = await cdp.send('Runtime.evaluate', { expression: '40+2', returnByValue: true });
  assert.equal(res.result.value, 42);
});

test('waits for Chromium that is not running yet', async () => {
  const port = await freePort();
  const cdp = new Cdp({ port, minBackoff: 100, maxBackoff: 300 });
  cleanups.push(() => cdp.stop());
  cdp.start();
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(cdp.connected, false);
  const chromium = await launchChromium({ port });
  cleanups.push(() => chromium.close());
  await withTimeout(once(cdp, 'connected'), 15000, 'late connect');
  assert.equal(cdp.connected, true);
});
