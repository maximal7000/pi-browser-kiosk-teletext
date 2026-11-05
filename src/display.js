// Keeps the kiosk Chromium in the state the store describes: url, zoom, black.
import { EventEmitter } from 'node:events';

const OVERLAY_ID = '__pi_anzeige_black';

// Runs in every new document while black is on, and once on the current one.
const BLACK_ON = `(() => {
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

const BLACK_OFF = `window[${JSON.stringify(OVERLAY_ID)}] = false; document.getElementById(${JSON.stringify(OVERLAY_ID)})?.remove()`;

export function zoomMetrics({ width, height }, zoom) {
  return {
    width: Math.round(width / zoom),
    height: Math.round(height / zoom),
    deviceScaleFactor: zoom,
    mobile: false,
  };
}

export function createDisplay({ cdp, store, startUrl, retryDelays = [30000, 60000, 300000] }) {
  const emitter = new EventEmitter();
  let status = { connected: cdp.connected, loading: false, error: null, screen: null };
  let applied = {};
  let blackScriptId = null;
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
    if (!status.screen) return;
    if (zoom === 1) await cdp.send('Emulation.clearDeviceMetricsOverride');
    else await cdp.send('Emulation.setDeviceMetricsOverride', zoomMetrics(status.screen, zoom));
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

  async function sync({ force = false } = {}) {
    if (!cdp.connected) return;
    const { current, black } = store.get();
    const url = current.url ?? startUrl;
    // Black first so a new page never flashes before the overlay is in place.
    if (force || black !== applied.black) await applyBlack(black);
    if (force || current.zoom !== applied.zoom) await applyZoom(current.zoom);
    if (force || url !== applied.url) await navigate(url);
  }

  async function readScreen() {
    const { targetInfo } = await cdp.send('Target.getTargetInfo');
    const { bounds } = await cdp.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
    return { width: bounds.width, height: bounds.height };
  }

  cdp.on('connected', () => {
    applied = {};
    blackScriptId = null;
    enqueue(async () => {
      await cdp.send('Page.enable');
      setStatus({ connected: true, screen: await readScreen() });
      await sync({ force: true });
    });
  });

  cdp.on('disconnected', () => {
    clearRetry();
    setStatus({ connected: false, loading: false });
  });

  cdp.on('Page.loadEventFired', () => setStatus({ loading: false }));

  store.on('change', () => enqueue(() => sync()));

  return Object.assign(emitter, {
    status: () => ({ ...status }),
    apply: () => enqueue(() => sync({ force: true })),
    reload: () => enqueue(async () => {
      if (cdp.connected) await cdp.send('Page.reload', { ignoreCache: true });
    }),
  });
}
