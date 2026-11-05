// Minimal Chrome DevTools Protocol client that keeps one page target connected.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export class Cdp extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 9222, minBackoff = 1000, maxBackoff = 10000 } = {}) {
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
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  #base() {
    return `http://${this.host}:${this.port}`;
  }

  async #pageTarget() {
    const res = await fetch(`${this.#base()}/json/list`);
    const targets = await res.json();
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page) return page.webSocketDebuggerUrl;
    const created = await fetch(`${this.#base()}/json/new?about:blank`, { method: 'PUT' });
    return (await created.json()).webSocketDebuggerUrl;
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
