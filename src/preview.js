// Streams screencast frames to control panels, and only while someone watches.
export function createPreview({ cdp, maxFps = 2, maxWidth = 960, quality = 60 }) {
  const viewers = new Map();
  const interval = 1000 / maxFps;
  let lastFrame = null;
  let lastSentAt = 0;
  let pending = null;
  let trailingTimer = null;
  const api = { lastFrameAt: null };

  const warn = (err) => { if (cdp.connected) console.warn(`preview: ${err.message}`); };

  let generation = 0;

  // Chromium only sends screencast frames when something repaints, so a static
  // page would leave the preview empty; a one-off screenshot fills that gap.
  async function seed(gen) {
    const { cssLayoutViewport } = await cdp.send('Page.getLayoutMetrics');
    const { clientWidth: width, clientHeight: height } = cssLayoutViewport;
    const scale = Math.min(1, maxWidth / width);
    const { data } = await cdp.send('Page.captureScreenshot', {
      format: 'jpeg', quality, clip: { x: 0, y: 0, width, height, scale },
    });
    if (gen !== generation || viewers.size === 0) return;
    const buf = Buffer.from(data, 'base64');
    lastFrame = buf;
    api.lastFrameAt = Date.now();
    broadcast(buf);
  }

  function start() {
    if (!cdp.connected) return;
    const gen = ++generation;
    cdp.send('Page.startScreencast', { format: 'jpeg', quality, maxWidth, everyNthFrame: 1 }).catch(warn);
    seed(gen).catch(warn);
  }

  function stop() {
    generation += 1;
    clearTimeout(trailingTimer);
    trailingTimer = null;
    if (pending) ack(pending.sessionId);
    pending = null;
    if (!cdp.connected) return;
    cdp.send('Page.stopScreencast').catch(warn);
  }

  function broadcast(buf) {
    lastSentAt = Date.now();
    for (const send of viewers.values()) send(buf);
  }

  const ack = (sessionId) => cdp.send('Page.screencastFrameAck', { sessionId }).catch(warn);

  // Chromium waits for an ack before it captures the next frame, so holding the
  // ack until the next send slot keeps the Pi from encoding frames nobody sees.
  cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
    generation += 1; // a real frame makes any in-flight seed stale
    const buf = Buffer.from(data, 'base64');
    lastFrame = buf;
    api.lastFrameAt = Date.now();
    const wait = lastSentAt + interval - Date.now();
    if (viewers.size === 0 || (wait <= 0 && !trailingTimer)) {
      if (viewers.size > 0) broadcast(buf);
      ack(sessionId);
      return;
    }
    if (pending) ack(pending.sessionId); // superseded before it was sent
    pending = { buf, sessionId };
    if (!trailingTimer) {
      trailingTimer = setTimeout(() => {
        trailingTimer = null;
        const next = pending;
        pending = null;
        if (!next) return;
        if (viewers.size > 0) broadcast(next.buf);
        ack(next.sessionId);
      }, Math.max(wait, 0));
    }
  });

  cdp.on('connected', () => {
    if (viewers.size > 0) start();
  });

  return Object.assign(api, {
    addViewer(id, send) {
      const first = viewers.size === 0;
      viewers.set(id, send);
      if (lastFrame) send(lastFrame);
      if (first) start();
    },
    removeViewer(id) {
      if (!viewers.delete(id)) return;
      if (viewers.size === 0) stop();
    },
    viewerCount: () => viewers.size,
  });
}
