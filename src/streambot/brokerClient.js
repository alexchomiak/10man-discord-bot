'use strict';

const { WebSocket } = require('ws');

const CAPABILITIES = ['play', 'join', 'move', 'stop', 'status', 'skip', 'scrub', 'seek', 'pause', 'resume', 'catchup', 'toggle-overlay', 'reorder', 'remove-queued', 'set-global-name'];

class StreamBrokerClient {
  constructor({ url, secret, workerId, control, streamManager, log = console.log } = {}) {
    this.url = url;
    this.secret = secret;
    this.workerId = workerId;
    this.control = control;
    this.streamManager = streamManager;
    this.log = log;
    this.socket = null;
    this.closed = false;
    this.reconnectTimer = null;
    this.statusTimer = null;
    this.results = new Map();
  }

  get enabled() { return !!(this.url && this.secret); }

  start() {
    if (!this.enabled || this.closed || this.socket) return;
    let socket;
    try {
      socket = new WebSocket(this.url, { headers: { Authorization: `Bearer ${this.secret}` }, maxPayload: 64 * 1024 });
    } catch (error) {
      this.log(`[streambot:${this.workerId}] broker error: ${error.message}`);
      this._scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.on('open', () => {
      this.log(`[streambot:${this.workerId}] connected to stream broker`);
      this._send({
        type: 'register',
        workerId: this.workerId,
        userId: this.streamManager?.client?.user?.id || null,
        capabilities: CAPABILITIES,
        status: this.streamManager.status()
      });
      this.statusTimer = setInterval(() => this._send({ type: 'status', status: this.streamManager.status() }), 5000);
      this.statusTimer.unref?.();
    });
    socket.on('message', raw => void this._message(raw));
    socket.on('error', error => this.log(`[streambot:${this.workerId}] broker error: ${error.message}`));
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      clearInterval(this.statusTimer);
      this.statusTimer = null;
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.start();
    }, 3000);
    this.reconnectTimer.unref?.();
  }

  _send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      this.log(`[streambot:${this.workerId}] broker response serialization failed: ${error.message}`);
      // A bad command result must still settle the app bot's request instead
      // of becoming an unhandled rejection and timing the interaction out.
      if (message?.type === 'result' && message.requestId) {
        try {
          this.socket.send(JSON.stringify({
            type: 'result', requestId: message.requestId,
            result: { ok: false, message: 'Stream worker returned an invalid response.', status: null }
          }));
        } catch { /* the socket closed while sending the fallback */ }
      }
      return false;
    }
  }

  async _message(raw) {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type !== 'command' || !message.requestId) return;
    const cached = this.results.get(message.requestId);
    if (cached) { this._send(cached); return; }
    let result;
    try {
      result = await this.control.execute(message.operation, message.payload || {});
    } catch (error) {
      result = { ok: false, message: error?.message || 'Stream command failed.', status: this.streamManager.status() };
    }
    const response = { type: 'result', requestId: message.requestId, result };
    if (this._send(response)) {
      this.results.set(message.requestId, response);
      if (this.results.size > 100) this.results.delete(this.results.keys().next().value);
    }
    this._send({ type: 'status', status: this.streamManager.status() });
  }

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.statusTimer);
    this.socket?.terminate();
    this.socket = null;
  }
}

module.exports = { StreamBrokerClient, CAPABILITIES };
