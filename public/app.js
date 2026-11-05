// Pi-Anzeige control panel: talks to /api and /live, renders the teletext UI.
const $ = (id) => document.getElementById(id);

let snapshot = null; // { state, display }
let socketUp = false;
let paused = false;
let frameUrl = null;
let lastFrameAt = null;
let lastOwnAction = 0;
let formMode = null; // { mode: 'create' } | { mode: 'edit', id }
const flagged = new Set(); // page ids changed from another panel

const pct = (z) => `${Math.round(z * 100)} %`;
const two = (n) => String(n).padStart(2, '0');
const hms = (d) => `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
const announce = (text) => { $('announce').textContent = text; };

/* ---------- api ---------- */

async function api(method, path, body) {
  lastOwnAction = Date.now();
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  lastOwnAction = Date.now();
  if (!res.ok) throw new Error(data?.error ?? 'Das hat nicht geklappt.');
  return data;
}

function showError(id, err) {
  const el = $(id);
  if (!err) { el.hidden = true; el.textContent = ''; return; }
  el.textContent = err.message === 'Failed to fetch' ? 'Keine Verbindung zum Pi.' : err.message;
  el.hidden = false;
}

/* ---------- live socket ---------- */

let ws = null;
let retry = 500;

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/live`);
  ws.binaryType = 'blob';
  ws.onopen = () => {
    socketUp = true;
    retry = 500;
    syncWatching();
    render();
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') onState(JSON.parse(ev.data));
    else onFrame(ev.data);
  };
  ws.onclose = () => {
    socketUp = false;
    render();
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 5000);
  };
}

function syncWatching() {
  if (!socketUp) return;
  const on = !paused && document.visibilityState === 'visible';
  ws.send(JSON.stringify({ type: 'preview', on }));
}

function onState(msg) {
  if (msg.type !== 'state') return;
  const prev = snapshot;
  snapshot = { state: msg.state, display: msg.display };
  // Mark a page switch that this panel did not ask for.
  const own = Date.now() - lastOwnAction < 2000;
  const before = prev?.state.current.pageId;
  const after = msg.state.current.pageId;
  if (prev && !own && after && after !== before) flagged.add(after);
  render();
}

function frameImg() {
  let img = $('frameImg');
  if (!img) {
    img = document.createElement('img');
    img.id = 'frameImg';
    img.alt = 'Live-Bild des Bildschirms';
    $('frame').prepend(img);
  }
  return img;
}

function onFrame(blob) {
  const img = frameImg();
  const next = URL.createObjectURL(blob);
  img.onload = () => { if (frameUrl && frameUrl !== next) URL.revokeObjectURL(frameUrl); frameUrl = next; };
  img.src = next;
  lastFrameAt = new Date();
  $('lastFrame').textContent = `Letztes Bild ${hms(lastFrameAt)}`;
  render();
}

/* ---------- rendering ---------- */

function currentPage() {
  if (!snapshot) return null;
  const { current, pages } = snapshot.state;
  return pages.find((p) => p.id === current.pageId) ?? null;
}

function renderHeader() {
  const conn = $('conn');
  const d = snapshot?.display;
  let text = 'VERBUNDEN';
  let cls = '';
  if (!socketUp || !d?.connected) { text = 'VERBINDET NEU'; cls = 'warn'; }
  else if (d.error) { text = 'SEITE NICHT ERREICHBAR'; cls = 'bad'; }
  conn.textContent = text;
  conn.className = `conn ${cls}`;
  if (!seek) {
    const page = currentPage();
    $('pnum').textContent = page ? `P${page.number}` : 'P---';
  }
}

function renderScreen() {
  const { state, display } = snapshot;
  const page = currentPage();
  $('nowName').textContent = page ? page.name : state.current.url ? 'Freie Adresse' : 'Startseite';
  $('nowUrl').textContent = state.current.url ?? '';
  const frame = $('frame');
  frame.classList.toggle('is-black', state.black);
  frame.classList.toggle('is-paused', paused);
  if (display.screen) {
    frame.style.aspectRatio = `${display.screen.width} / ${display.screen.height}`;
    $('resolution').textContent = `${display.screen.width} × ${display.screen.height}`;
  }
  const msg = $('frameMsg');
  if (!display.connected) { msg.textContent = 'BILDSCHIRM NICHT VERBUNDEN'; msg.hidden = false; }
  else if (!lastFrameAt) { msg.textContent = paused ? 'VORSCHAU PAUSIERT' : 'VORSCHAU STARTET …'; msg.hidden = false; }
  else msg.hidden = true;
  $('live').classList.toggle('off', paused);
  $('liveText').textContent = paused ? 'PAUSIERT' : 'LIVE';
  $('pauseBtn').textContent = paused ? 'Vorschau fortsetzen' : 'Vorschau pausieren';
  $('kBlack').setAttribute('aria-pressed', String(state.black));
  $('kBlackLbl').textContent = state.black ? 'LICHT AN' : 'SCHWARZ';
}

function renderIndex() {
  const { state } = snapshot;
  const list = $('index');
  if (state.pages.length === 0) {
    list.innerHTML = '<li><span class="empty">Noch keine Seiten. Adresse eingeben und mit Grün speichern.</span></li>';
    return;
  }
  list.replaceChildren(...state.pages.map((p) => {
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `row${flagged.has(p.id) ? ' flag' : ''}`;
    row.dataset.number = p.number;
    row.dataset.id = p.id;
    row.setAttribute('aria-current', String(p.id === state.current.pageId));
    const n = document.createElement('span'); n.className = 'n'; n.textContent = p.number;
    const t = document.createElement('span'); t.className = 't'; t.textContent = p.name;
    const z = document.createElement('span'); z.className = 'z'; z.textContent = pct(p.zoom);
    row.append(n, t, z);
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'textbtn edit';
    edit.dataset.edit = p.id;
    edit.textContent = 'Ändern';
    edit.setAttribute('aria-label', `${p.name} ändern`);
    li.append(row, edit);
    return li;
  }));
}

function renderZoom() {
  const { state } = snapshot;
  const zoom = state.current.zoom;
  if (document.activeElement !== $('zoom')) $('zoom').value = Math.round(zoom * 100);
  $('zOut').textContent = pct(zoom);
  const page = currentPage();
  $('saveZoomRow').hidden = !(page && page.zoom !== zoom);
  if (page) $('savedZoom').textContent = pct(page.zoom);
}

function render() {
  renderHeader();
  if (!snapshot) return;
  renderScreen();
  renderIndex();
  renderZoom();
}

/* ---------- actions ---------- */

async function showPage(id) {
  flagged.delete(id);
  try {
    await api('PUT', '/api/current', { pageId: id });
    const page = snapshot.state.pages.find((p) => p.id === id);
    if (page) announce(`${page.name} wird angezeigt`);
  } catch (err) {
    announce(err.message);
  }
}

async function showNumber(number) {
  const page = snapshot?.state.pages.find((p) => p.number === number);
  if (!page) {
    $('pnum').textContent = `P${number}`;
    announce(`Seite ${number} gibt es nicht`);
    setTimeout(render, 900);
    return;
  }
  await showPage(page.id);
}

async function toggleBlack() {
  if (!snapshot) return;
  const black = !snapshot.state.black;
  try {
    await api('PUT', '/api/black', { black });
    announce(black ? 'Bildschirm schwarz' : 'Bildschirm zeigt wieder die Seite');
  } catch (err) {
    announce(err.message);
  }
}

let zoomTimer = null;
function setZoom(percent, { now = false } = {}) {
  const value = Math.max(25, Math.min(300, Math.round(percent / 5) * 5));
  $('zOut').textContent = `${value} %`;
  $('zoom').value = value;
  clearTimeout(zoomTimer);
  const send = async () => {
    try {
      await api('PUT', '/api/zoom', { zoom: value / 100 });
      showError('zoomErr', null);
    } catch (err) {
      showError('zoomErr', err);
    }
  };
  if (now) send();
  else zoomTimer = setTimeout(send, 150);
}

async function reload() {
  try {
    await api('POST', '/api/reload');
    announce('Seite wird neu geladen');
  } catch (err) {
    announce(err.message);
  }
}

/* ---------- page form ---------- */

function nextNumber() {
  const numbers = snapshot.state.pages.map((p) => p.number);
  return Math.max(100, ...numbers) + 1;
}

function openForm(mode, id) {
  formMode = { mode, id };
  const page = id ? snapshot.state.pages.find((p) => p.id === id) : null;
  $('formH').textContent = mode === 'edit' ? 'SEITE ÄNDERN' : 'SEITE SPEICHERN';
  $('formName').value = page ? page.name : '';
  $('formUrl').value = page ? page.url : snapshot.state.current.url ?? '';
  $('formNumber').value = page ? page.number : '';
  $('formNumberField').hidden = mode !== 'edit';
  $('formSave').textContent = mode === 'edit' ? 'Speichern' : `Als ${nextNumber()} speichern`;
  $('formDelete').hidden = mode !== 'edit';
  $('formDeleteConfirm').hidden = true;
  showError('formErr', null);
  $('pageForm').hidden = false;
  $('formName').focus();
}

function closeForm() {
  formMode = null;
  $('pageForm').hidden = true;
}

async function saveForm() {
  const name = $('formName').value;
  const url = $('formUrl').value;
  const btn = $('formSave');
  btn.disabled = true;
  try {
    if (formMode.mode === 'edit') {
      const number = Number($('formNumber').value);
      await api('PUT', `/api/pages/${formMode.id}`, { name, url, number });
      announce(`${name.trim()} gespeichert`);
    } else {
      const { page } = await api('POST', '/api/pages', { name, url, zoom: snapshot.state.current.zoom });
      // A page saved from what is showing becomes the current page.
      if (snapshot.state.current.url === page.url) await api('PUT', '/api/current', { pageId: page.id });
      announce(`${page.name} als ${page.number} gespeichert`);
    }
    closeForm();
  } catch (err) {
    showError('formErr', err);
  } finally {
    btn.disabled = false;
  }
}

async function deleteFromForm() {
  try {
    await api('DELETE', `/api/pages/${formMode.id}`);
    announce('Seite gelöscht');
    closeForm();
  } catch (err) {
    showError('formErr', err);
  }
}

/* ---------- events ---------- */

$('index').addEventListener('click', (e) => {
  const edit = e.target.closest('[data-edit]');
  if (edit) return openForm('edit', edit.dataset.edit);
  const row = e.target.closest('.row');
  if (row) showPage(row.dataset.id);
});
const unflag = (e) => {
  const row = e.target.closest?.('.row');
  if (row && flagged.delete(row.dataset.id)) row.classList.remove('flag');
};
$('index').addEventListener('pointerover', unflag);
$('index').addEventListener('focusin', unflag);

$('urlForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('PUT', '/api/current', { url: $('url').value });
    showError('urlErr', null);
    $('url').value = '';
    announce('Adresse wird angezeigt');
  } catch (err) {
    showError('urlErr', err);
  }
});

$('zoom').addEventListener('input', (e) => setZoom(Number(e.target.value)));
$('zMinus').addEventListener('click', () => setZoom(Number($('zoom').value) - 5, { now: true }));
$('zPlus').addEventListener('click', () => setZoom(Number($('zoom').value) + 5, { now: true }));
$('saveZoom').addEventListener('click', async () => {
  const page = currentPage();
  if (!page) return;
  try {
    await api('PUT', `/api/pages/${page.id}`, { zoom: snapshot.state.current.zoom });
    announce('Zoom gespeichert');
  } catch (err) {
    showError('zoomErr', err);
  }
});

$('kBlack').addEventListener('click', toggleBlack);
$('kSave').addEventListener('click', () => snapshot && openForm('create'));
$('kZoom').addEventListener('click', () => setZoom(100, { now: true }));
$('kReload').addEventListener('click', reload);
$('formSave').addEventListener('click', saveForm);
$('formCancel').addEventListener('click', closeForm);
$('formDelete').addEventListener('click', () => { $('formDeleteConfirm').hidden = false; $('formDeleteYes').focus(); });
$('formDeleteNo').addEventListener('click', () => { $('formDeleteConfirm').hidden = true; });
$('formDeleteYes').addEventListener('click', deleteFromForm);
$('pageForm').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('input')) saveForm();
  if (e.key === 'Escape') closeForm();
});

$('pauseBtn').addEventListener('click', () => {
  paused = !paused;
  syncWatching();
  render();
});
document.addEventListener('visibilitychange', syncWatching);

// Teletext ritual: type three digits anywhere to switch page.
let seek = '';
let seekTimer = null;
function endSeek() {
  seek = '';
  clearTimeout(seekTimer);
  $('pnum').classList.remove('seek');
  render();
}
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (/^[0-9]$/.test(k)) {
    if (seek === '' && k === '0') { setZoom(100, { now: true }); return; }
    seek += k;
    clearTimeout(seekTimer);
    const pn = $('pnum');
    pn.classList.add('seek');
    pn.textContent = `P${(seek + '___').slice(0, 3)}`;
    if (seek.length === 3) {
      const number = Number(seek);
      seek = '';
      pn.classList.remove('seek');
      showNumber(number);
    } else {
      seekTimer = setTimeout(endSeek, 2500);
    }
    return;
  }
  if (k === 'escape' && seek) return endSeek();
  if (k === 'b') return toggleBlack();
  if (k === 'r') return reload();
  if (k === 's') { e.preventDefault(); if (snapshot) openForm('create'); }
});

/* ---------- clock + mosaic ---------- */

const DAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
function tick() {
  const d = new Date();
  $('clock').textContent = hms(d);
  $('date').textContent = `${DAYS[d.getDay()]} ${two(d.getDate())}.${two(d.getMonth() + 1)}.`;
}
setInterval(tick, 1000);
tick();

// A strip of teletext sixel blocks in the seven colours, seeded so it never changes.
function mosaic() {
  const c = $('mosaic');
  const w = c.clientWidth;
  const h = 10;
  const dpr = window.devicePixelRatio || 1;
  c.width = w * dpr;
  c.height = h * dpr;
  const g = c.getContext('2d');
  g.scale(dpr, dpr);
  const style = getComputedStyle(document.documentElement);
  const cols = ['--red', '--green', '--yellow', '--blue', '--magenta', '--cyan', '--white'].map((v) => style.getPropertyValue(v).trim());
  let s = 7;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let x = 0, i = 0; x < w; x += 10, i++) {
    g.fillStyle = cols[Math.floor(i / 6) % cols.length];
    for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
      if (rnd() > 0.55) g.fillRect(x + sx * 5, sy * 5, 5, 5);
    }
  }
}
addEventListener('resize', mosaic);
document.fonts.ready.then(mosaic);

connect();
