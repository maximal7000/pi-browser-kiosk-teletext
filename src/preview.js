// Streams screencast frames to control panels, and only while someone watches.
export function createPreview({ cdp, maxFps = 2, boostFps = 5, maxWidth = 960, quality = 60, retryDelay = 500, retries = 10 }) {
  const viewers = new Map();
  let boostUntil = 0;
  // Faster frames for a while after remote input, so the operator sees what they do.
  const interval = () => 1000 / (Date.now() < boostUntil ? boostFps : maxFps);
  let lastFrame = null;
  let lastSentAt = 0;
  let pending = null;
  let trailingTimer = null;
  const api = { lastFrameAt: null };

  const warn = (err) => { if (cdp.connected) console.warn(`preview: ${err.message}`); };

  let generation = 0;

  // Chromium only sends screencast frames when something repaints, so a static
  // page would leave the preview empty; a one-off screenshot fills that gap.
  // No clip/scale: a scaled capture makes a visible Chromium briefly redraw the
  // page shrunk into the top-left corner of the real screen.
  async function seed(gen) {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality });
    if (gen !== generation || viewers.size === 0) return;
    const buf = Buffer.from(data, 'base64');
    lastFrame = buf;
    api.lastFrameAt = Date.now();
    broadcast(buf);
  }

  // Chromium refuses both calls while a navigation is committing
  // ("Not attached to an active page"), so try again shortly.
  function start(attempt = 0) {
    if (!cdp.connected || viewers.size === 0) return;
    const gen = ++generation;
    const retry = (err) => {
      if (attempt >= retries || gen !== generation) return warn(err);
      setTimeout(() => { if (gen === generation) start(attempt + 1); }, retryDelay);
    };
    cdp.send('Page.startScreencast', { format: 'jpeg', quality, maxWidth, everyNthFrame: 1 })
      .then(() => seed(gen))
      .catch(retry);
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
    const wait = lastSentAt + interval() - Date.now();
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
    boost(ms = 10000) {
      boostUntil = Date.now() + ms;
    },
  });
}
