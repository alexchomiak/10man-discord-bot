'use strict';

const { WebSocket } = require('ws');

const CAPABILITIES = ['play', 'join', 'move', 'stop', 'status', 'skip', 'scrub', 'seek', 'pause', 'resume', 'catchup', 'toggle-overlay', 'toggle-music-mode', 'reorder', 'remove-queued', 'set-global-name', 'resolve-channel'];

function ownProfile(user) {
  if (!user) return null;
  return {
    displayName: user.globalName || user.username || null,
    globalName: user.globalName || null,
    username: user.username || null,
    avatarUrl: user.displayAvatarURL?.({ extension: 'png', size: 128 }) || null
  };
}

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
        accessCode: this.streamManager?.config?.dashboardAccessCode,
        userId: this.streamManager?.client?.user?.id || null,
        profile: ownProfile(this.streamManager?.client?.user),
        capabilities: CAPABILITIES,
        status: this.streamManager.status(), musicMode: this.streamManager.musicMode === true
      });
      void this._publishExternalChannels(socket);
      this.statusTimer = setInterval(() => this._send({ type: 'status', status: this.streamManager.status(),
        profile: ownProfile(this.streamManager?.client?.user),
        musicMode: this.streamManager.musicMode === true }), 5000);
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

  async _publishExternalChannels(socket) {
    const entries = this.streamManager?.config?.externalChannels || [];
    const resolved = await Promise.all(entries.map(async entry => {
      let timer;
      try {
        const result = await Promise.race([
          this.control.execute('resolve-channel', { guildId: entry.guildId, channelId: entry.id }),
          new Promise(resolve => { timer = setTimeout(() => resolve(null), 4000); })
        ]);
        if (!result?.ok) return null;
        return { guildId: result.guildId, guildName: result.guildName,
          id: result.channelId, name: result.channelName, type: result.channelType };
      } catch { return null; }
      finally { clearTimeout(timer); }
    }));
    if (this.socket === socket && socket.readyState === WebSocket.OPEN) {
      this._send({ type: 'external-channels', channels: resolved.filter(Boolean) });
    }
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
    this._send({ type: 'status', status: this.streamManager.status(),
      profile: ownProfile(this.streamManager?.client?.user),
      musicMode: this.streamManager.musicMode === true });
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
