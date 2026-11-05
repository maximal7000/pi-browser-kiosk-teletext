import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, validateUrl, normalizeZoom, ValidationError } from '../src/state.js';

async function tempFile() {
  const dir = await mkdtemp(join(tmpdir(), 'pi-anzeige-state-'));
  return { dir, file: join(dir, 'sub', 'config.json') };
}

test('missing file yields the empty state', async () => {
  const { file } = await tempFile();
  const store = await createStore({ file });
  assert.deepEqual(store.get(), {
    current: { url: null, zoom: 1, pageId: null },
    black: false,
    pages: [],
  });
});

test('validateUrl accepts only http and https', () => {
  for (const bad of ['ftp://x', 'javascript:alert(1)', '', 'not a url']) {
    assert.throws(() => validateUrl(bad), ValidationError, bad);
  }
  assert.throws(() => validateUrl('ftp://x'), { message: 'Bitte eine Adresse mit http:// oder https:// eingeben.' });
  assert.equal(validateUrl(' https://a.de '), 'https://a.de/');
});

test('normalizeZoom rounds to 0.05 and enforces 0.25–3', () => {
  assert.equal(normalizeZoom(1.12), 1.1);
  assert.equal(normalizeZoom(0.25), 0.25);
  assert.equal(normalizeZoom(3), 3);
  assert.throws(() => normalizeZoom(0.2), { message: 'Zoom muss zwischen 25 % und 300 % liegen.' });
  assert.throws(() => normalizeZoom(3.05), ValidationError);
  assert.throws(() => normalizeZoom('abc'), ValidationError);
});

test('addPage assigns numbers from 101 upwards', async () => {
  const { file } = await tempFile();
  const store = await createStore({ file });
  const a = await store.addPage({ name: '  Wetter ', url: 'https://w.example' });
  const b = await store.addPage({ name: 'Kalender', url: 'https://c.example', zoom: 1.25 });
  assert.equal(a.number, 101);
  assert.equal(a.name, 'Wetter');
  assert.equal(a.zoom, 1);
  assert.equal(b.number, 102);
  await store.removePage(a.id);
  const c = await store.addPage({ name: 'Bahn', url: 'https://b.example' });
  assert.equal(c.number, 103);
});

test('addPage rejects empty names and duplicate numbers', async () => {
  const { file } = await tempFile();
  const store = await createStore({ file });
  await assert.rejects(store.addPage({ name: '  ', url: 'https://a.de' }), { message: 'Bitte einen Namen eingeben.' });
  await store.addPage({ name: 'A', url: 'https://a.de', number: 150 });
  await assert.rejects(store.addPage({ name: 'B', url: 'https://b.de', number: 150 }), { message: 'Seitennummer ist schon vergeben.' });
  await assert.rejects(store.addPage({ name: 'B', url: 'https://b.de', number: 200 }), ValidationError);
});

test('updatePage changes fields and validates them', async () => {
  const { file } = await tempFile();
  const store = await createStore({ file });
  const p = await store.addPage({ name: 'A', url: 'https://a.de' });
  const q = await store.updatePage(p.id, { name: 'B', zoom: 1.5 });
  assert.equal(q.name, 'B');
  assert.equal(q.zoom, 1.5);
  assert.equal(q.number, 101);
  await assert.rejects(store.updatePage(p.id, { url: 'file:///etc/passwd' }), ValidationError);
  await assert.rejects(store.updatePage('nope', { name: 'x' }), { status: 404 });
});

test('show by pageId copies url and zoom; show by url clears pageId', async () => {
  const { file } = await tempFile();
  const store = await createStore({ file });
  const p = await store.addPage({ name: 'A', url: 'https://a.de', zoom: 1.1 });
  let s = await store.show({ pageId: p.id });
  assert.deepEqual(s.current, { url: 'https://a.de/', zoom: 1.1, pageId: p.id });
  s = await store.show({ url: 'https://b.de' });
  assert.deepEqual(s.current, { url: 'https://b.de/', zoom: 1, pageId: null });
  s = await store.show({ url: 'https://c.de', zoom: 2 });
  assert.equal(s.current.zoom, 2);
  await assert.rejects(store.show({ pageId: 'nope' }), { status: 404, message: 'Seite nicht gefunden.' });
});

test('setZoom and setBlack update the state', async () => {
  const { file } = await tempFile();
  const store = await createStore({ file });
  assert.equal((await store.setZoom(1.5)).current.zoom, 1.5);
  assert.equal((await store.setBlack(true)).black, true);
  await assert.rejects(store.setBlack('yes'), ValidationError);
});

test('removing the shown page keeps the url and clears pageId', async () => {
  const { file } = await tempFile();
  const store = await createStore({ file });
  const p = await store.addPage({ name: 'A', url: 'https://a.de' });
  await store.show({ pageId: p.id });
  await store.removePage(p.id);
  assert.deepEqual(store.get().current, { url: 'https://a.de/', zoom: 1, pageId: null });
});

test('state survives a new store on the same file', async () => {
  const { file } = await tempFile();
  const store = await createStore({ file });
  await store.addPage({ name: 'A', url: 'https://a.de' });
  await store.setBlack(true);
  const again = await createStore({ file });
  assert.equal(again.get().pages.length, 1);
  assert.equal(again.get().black, true);
});

test('a corrupt file is moved aside and the store starts empty', async () => {
  const { dir } = await tempFile();
  const file = join(dir, 'config.json');
  await writeFile(file, '{nope');
  const store = await createStore({ file });
  assert.deepEqual(store.get().pages, []);
  const names = await readdir(dir);
  assert.ok(names.some((n) => /^config\.json\.broken-\d+$/.test(n)), names.join(','));
});

test('concurrent writes are serialized and the file stays valid', async () => {
  const { file } = await tempFile();
  const store = await createStore({ file });
  await Promise.all([
    store.addPage({ name: 'A', url: 'https://a.de' }),
    store.addPage({ name: 'B', url: 'https://b.de' }),
    store.setBlack(true),
  ]);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.pages.length, 2);
  assert.notEqual(saved.pages[0].number, saved.pages[1].number);
  assert.equal(saved.black, true);
});

test('change fires once per write with the new state', async () => {
  const { file } = await tempFile();
  const store = await createStore({ file });
  const seen = [];
  store.on('change', (s) => seen.push(s));
  await store.setBlack(true);
  await store.setZoom(2);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].current.zoom, 2);
  assert.equal(seen[1].black, true);
});

test('editing the shown page updates what is shown', async () => {
  const { file } = await tempFile();
  const store = await createStore({ file });
  const p = await store.addPage({ name: 'A', url: 'https://a.de' });
  await store.show({ pageId: p.id });
  await store.updatePage(p.id, { url: 'https://b.de', zoom: 1.5 });
  assert.deepEqual(store.get().current, { url: 'https://b.de/', zoom: 1.5, pageId: p.id });
});

test('show emits change with reason show', async () => {
  const { file } = await tempFile();
  const store = await createStore({ file });
  const reasons = [];
  store.on('change', (_, meta) => reasons.push(meta?.reason));
  await store.show({ url: 'https://a.de' });
  await store.setBlack(true);
  assert.deepEqual(reasons, ['show', undefined]);
});
