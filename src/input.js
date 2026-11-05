// Remote input from the control panel: validates messages and replays them as
// real mouse and keyboard events on the kiosk page via CDP.

export const KEYS = {
  Enter: { code: 'Enter', keyCode: 13 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
};

const MAX_TEXT = 2000;
const MAX_DELTA = 2000;

const unit = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const delta = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-MAX_DELTA, Math.min(MAX_DELTA, v)) : 0);

export function validateInput(msg) {
  if (!msg || typeof msg !== 'object') return null;
  switch (msg.kind) {
    case 'click':
      return unit(msg.x) && unit(msg.y) ? { kind: 'click', x: msg.x, y: msg.y } : null;
    case 'wheel':
      return unit(msg.x) && unit(msg.y) ? { kind: 'wheel', x: msg.x, y: msg.y, dx: delta(msg.dx), dy: delta(msg.dy) } : null;
    case 'text':
      return typeof msg.text === 'string' && msg.text.length > 0 && msg.text.length <= MAX_TEXT
        ? { kind: 'text', text: msg.text } : null;
    case 'key':
      return Object.hasOwn(KEYS, msg.key) ? { kind: 'key', key: msg.key } : null;
    default:
      return null;
  }
}

export function createInput({ cdp }) {
  let viewport = null;
  cdp.on('connected', () => { viewport = null; });

  async function size() {
    if (!viewport) {
      const { cssLayoutViewport } = await cdp.send('Page.getLayoutMetrics');
      viewport = { width: cssLayoutViewport.clientWidth, height: cssLayoutViewport.clientHeight };
    }
    return viewport;
  }

  async function point(msg) {
    const { width, height } = await size();
    return { x: Math.round(msg.x * (width - 1)), y: Math.round(msg.y * (height - 1)) };
  }

  const mouse = (params) => cdp.send('Input.dispatchMouseEvent', params);

  async function dispatch(m) {
    if (m.kind === 'click') {
      const { x, y } = await point(m);
      await mouse({ type: 'mouseMoved', x, y });
      await mouse({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await mouse({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    } else if (m.kind === 'wheel') {
      const { x, y } = await point(m);
      await mouse({ type: 'mouseWheel', x, y, deltaX: m.dx, deltaY: m.dy });
    } else if (m.kind === 'text') {
      await cdp.send('Input.insertText', { text: m.text });
    } else {
      const { code, keyCode } = KEYS[m.key];
      const base = { key: m.key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      if (m.key === 'Enter') await cdp.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    }
  }

  return {
    async handle(msg) {
      const m = validateInput(msg);
      if (!m || !cdp.connected) return false;
      try {
        await dispatch(m);
        return true;
      } catch {
        viewport = null; // a resize or reconnect may have made the cached size stale
        return false;
      }
    },
  };
}
