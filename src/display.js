// Keeps the kiosk Chromium in the state the store describes: url, zoom, black.
import { EventEmitter } from 'node:events';

const OVERLAY_ID = '__pi_anzeige_black';

// Runs in every new document while black is on, and once on the current one.
const BLACK_ON = `(() => {
  if (window !== window.top) return; // the top-level overlay already covers iframes
  const id = ${JSON.stringify(OVERLAY_ID)};
  window[id] = true;
  const add = () => {
    if (!window[id]) return true;
    const root = document.documentElement;
    if (!root) return false;
    if (!document.getElementById(id)) {
      const host = document.createElement('div');
      host.id = id;
      host.style.cssText = 'position:fixed;inset:0;background:#000;z-index:2147483647;pointer-events:none;display:block';
      host.attachShadow({ mode: 'closed' });
      root.appendChild(host);
    }
    return true;
  };
  const keep = () => new MutationObserver(add).observe(document.documentElement, { childList: true });
  if (add()) keep();
  else new MutationObserver((_, obs) => { if (add()) { obs.disconnect(); keep(); } }).observe(document, { childList: true });
})()`;

// cage shows the pointer whenever a mouse or touch device exists; the page decides
// what it looks like, so hide it in every frame of every document.
const HIDE_CURSOR = `(() => {
  const add = () => {
    const root = document.head || document.documentElement;
    if (!root) return false;
    const style = document.createElement('style');
    style.textContent = '*, *::before, *::after { cursor: none !important; }';
    root.appendChild(style);
    return true;
  };
  if (!add()) new MutationObserver((_, obs) => { if (add()) obs.disconnect(); }).observe(document, { childList: true });
})()`;

const BLACK_OFF = `window[${JSON.stringify(OVERLAY_ID)}] = false; document.getElementById(${JSON.stringify(OVERLAY_ID)})?.remove()`;

// CSS zoom relayouts like browser zoom and, unlike device-metrics emulation,
// changes what the physical screen shows (emulation only fills a corner of it).
export function zoomScript(zoom) {
  return `(() => {
  if (window !== window.top) return;
  const set = () => {
    const root = document.documentElement;
    if (!root) return false;
    if (${zoom} === 1) root.style.removeProperty('zoom');
    else root.style.setProperty('zoom', '${zoom}', 'important');
    return true;
  };
  if (!set()) new MutationObserver((_, obs) => { if (set()) obs.disconnect(); }).observe(document, { childList: true });
})()`;
}

export function createDisplay({ cdp, store, startUrl, retryDelays = [30000, 60000, 300000] }) {
  const emitter = new EventEmitter();
  let status = { connected: cdp.connected, loading: false, error: null, screen: null };
  let applied = {};
  let blackScriptId = null;
  let zoomScriptId = null;
  let retryTimer = null;
  let retryCount = 0;
  let chain = Promise.resolve();

  function setStatus(patch) {
    const next = { ...status, ...patch };
    if (JSON.stringify(next) === JSON.stringify(status)) return;
    status = next;
    emitter.emit('status', { ...status });
  }

  // Serialize all CDP work so a page switch and a zoom change never interleave.
  function enqueue(fn) {
    const run = chain.then(fn);
    chain = run.catch((err) => {
      if (cdp.connected) console.warn(`display: ${err.message}`);
    });
    return run;
  }

  function clearRetry() {
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  async function navigate(url, { retry = false } = {}) {
    clearRetry();
    if (!retry) retryCount = 0;
    applied.url = url;
    setStatus({ loading: true });
    const res = await cdp.send('Page.navigate', { url });
    if (res.errorText) {
      setStatus({ loading: false, error: 'Seite nicht erreichbar' });
      const delay = retryDelays[Math.min(retryCount, retryDelays.length - 1)];
      retryCount += 1;
      retryTimer = setTimeout(() => {
        if (applied.url === url) enqueue(() => navigate(url, { retry: true }));
      }, delay);
    } else {
      setStatus({ loading: false, error: null });
    }
  }

  async function applyZoom(zoom) {
    applied.zoom = zoom;
    if (zoomScriptId) {
      await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: zoomScriptId });
      zoomScriptId = null;
    }
    const source = zoomScript(zoom);
    if (zoom !== 1) {
      zoomScriptId = (await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source })).identifier;
    }
    await cdp.send('Runtime.evaluate', { expression: source });
  }

  async function applyBlack(black) {
    applied.black = black;
    if (black) {
      if (!blackScriptId) {
        const res = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: BLACK_ON });
        blackScriptId = res.identifier;
      }
      await cdp.send('Runtime.evaluate', { expression: BLACK_ON });
    } else {
      if (blackScriptId) {
        await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: blackScriptId });
        blackScriptId = null;
      }
      await cdp.send('Runtime.evaluate', { expression: BLACK_OFF });
    }
  }

  async function sync({ force = false, navigateAgain = false } = {}) {
    if (!cdp.connected) return;
    const { current, black } = store.get();
    const url = current.url ?? startUrl;
    // Black first so a new page never flashes before the overlay is in place.
    if (force || black !== applied.black) await applyBlack(black);
    if (force || current.zoom !== applied.zoom) await applyZoom(current.zoom);
    if (force || navigateAgain || url !== applied.url) await navigate(url);
  }

  async function readScreen() {
    try {
      const { targetInfo } = await cdp.send('Target.getTargetInfo');
      const { bounds } = await cdp.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
      return { width: bounds.width, height: bounds.height };
    } catch {
      const res = await cdp.send('Runtime.evaluate', {
        expression: '({ width: screen.width, height: screen.height })', returnByValue: true,
      });
      return res.result.value;
    }
  }

  cdp.on('connected', () => {
    applied = {};
    blackScriptId = null;
    zoomScriptId = null;
    enqueue(async () => {
      await cdp.send('Page.enable');
      await cdp.send('Inspector.enable').catch(() => {});
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: HIDE_CURSOR });
      await cdp.send('Runtime.evaluate', { expression: HIDE_CURSOR });
      setStatus({ connected: true, screen: await readScreen() });
      await sync({ force: true });
    });
  });

  // Nobody can click a dialog away on the kiosk; accept it so the page moves on.
  cdp.on('Page.javascriptDialogOpening', () => {
    cdp.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });

  // A renderer crash (e.g. out of memory on the Pi) leaves the debug socket open.
  let lastCrash = 0;
  cdp.on('Inspector.targetCrashed', () => {
    setStatus({ error: 'Seite abgestürzt' });
    const delay = Date.now() - lastCrash < 60000 ? 10000 : 1000;
    lastCrash = Date.now();
    // Navigate first: scripts cannot run in the dead renderer until a new page loads.
    setTimeout(() => enqueue(async () => {
      const { current, black } = store.get();
      await navigate(current.url ?? startUrl);
      await applyBlack(black);
      await applyZoom(current.zoom);
    }), delay);
  });

  cdp.on('disconnected', () => {
    clearRetry();
    setStatus({ connected: false, loading: false });
  });

  cdp.on('Page.loadEventFired', () => setStatus({ loading: false }));

  // Choosing a page again navigates even when it looks unchanged: the site may have moved on.
  store.on('change', (_, meta) => enqueue(() => sync({ navigateAgain: meta?.reason === 'show' })));

  return Object.assign(emitter, {
    status: () => ({ ...status }),
    apply: () => enqueue(() => sync({ force: true })),
    reload: () => enqueue(async () => {
      if (cdp.connected) await cdp.send('Page.reload', { ignoreCache: true });
    }),
  });
}
