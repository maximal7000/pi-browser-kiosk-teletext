// Minimal Chrome DevTools Protocol client that keeps one page target connected.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export class Cdp extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 9222, minBackoff = 1000, maxBackoff = 10000, commandTimeout = 15000 } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.minBackoff = minBackoff;
    this.maxBackoff = maxBackoff;
    this.connected = false;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.running = false;
    this.timer = null;
    this.backoff = minBackoff;
    this.commandTimeout = commandTimeout;
    this.targetId = null;
    this.on('Target.targetCreated', ({ targetInfo }) => {
      if (targetInfo.type === 'page' && targetInfo.targetId !== this.targetId) {
        this.send('Target.closeTarget', { targetId: targetInfo.targetId }).catch(() => {});
      }
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.backoff = this.minBackoff;
    this.#connect();
  }

  async stop() {
    this.running = false;
    clearTimeout(this.timer);
    const ws = this.ws;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      const closed = new Promise((r) => ws.once('close', r));
      ws.terminate();
      await closed;
    }
  }

  send(method, params = {}) {
    if (!this.connected || !this.ws) return Promise.reject(new Error('not connected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // A dialog or a hung renderer must never stall every later command.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, this.commandTimeout);
      const done = (fn) => (value) => { clearTimeout(timer); fn(value); };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject), method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  #base() {
    return `http://${this.host}:${this.port}`;
  }

  async #pageTarget() {
    const signal = AbortSignal.timeout(5000);
    const res = await fetch(`${this.#base()}/json/list`, { signal });
    const targets = (await res.json()).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    // Stay on the tab we controlled before; /json/list is ordered by recent activity.
    const page = targets.find((t) => t.id === this.targetId) ?? targets[0];
    if (page) {
      this.targetId = page.id;
      return page.webSocketDebuggerUrl;
    }
    const created = await (await fetch(`${this.#base()}/json/new?about:blank`, { method: 'PUT', signal })).json();
    this.targetId = created.id;
    return created.webSocketDebuggerUrl;
  }

  // The kiosk shows one tab. Popups and new tabs would cover it, so close them.
  async #closeOtherTabs() {
    await this.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await this.send('Target.getTargets');
    for (const t of targetInfos) {
      if (t.type === 'page' && t.targetId !== this.targetId) {
        await this.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
      }
    }
    await this.send('Page.bringToFront').catch(() => {});
  }

  #scheduleReconnect() {
    if (!this.running) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.#connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
  }

  async #connect() {
    if (!this.running) return;
    let url;
    try {
      url = await this.#pageTarget();
    } catch {
      this.#scheduleReconnect();
      return;
    }
    if (!this.running) return;
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this.backoff = this.minBackoff;
      this.#closeOtherTabs().catch(() => {});
      this.emit('connected');
    });
    ws.on('message', (data) => this.#onMessage(data));
    ws.on('error', () => {});
    ws.on('close', () => {
      const wasConnected = this.connected;
      this.connected = false;
      if (this.ws === ws) this.ws = null;
      for (const { reject } of this.pending.values()) reject(new Error('connection closed'));
      this.pending.clear();
      if (wasConnected) this.emit('disconnected');
      this.#scheduleReconnect();
    });
  }

  #onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`));
      else entry.resolve(msg.result);
    } else if (msg.method) {
      this.emit(msg.method, msg.params);
    }
  }
}
