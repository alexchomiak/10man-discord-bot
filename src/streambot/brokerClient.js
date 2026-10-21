'use strict';

const { WebSocket } = require('ws');
const { BROKER_MAX_PAYLOAD } = require('../workerChannels');
const { PresenceArtwork } = require('./presenceArtwork');

const CAPABILITIES = ['play', 'scheduled-play', 'join', 'move', 'stop', 'status', 'skip', 'scrub', 'seek', 'pause', 'resume', 'catchup', 'toggle-overlay', 'toggle-music-mode', 'reorder', 'remove-queued', 'set-global-name', 'resolve-channel', 'list-channels', 'set-content-nickname', 'set-content-preview', 'set-queue-limit', 'set-queue-gap', 'set-video-quality'];

function ownProfile(user, manager) {
  const guildId = manager?.voiceLink?.guildId;
  const guild = manager?.client?.guilds?.cache?.get(guildId);
  const nickname = guild?.members?.me?.nickname || guild?.members?.cache?.get(user?.id)?.nickname || null;
  if (!user) return null;
  return {
    displayName: nickname || user.globalName || user.username || null,
    nickname, guildId,
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
    this.artwork = new PresenceArtwork(streamManager, artifact => {
      this._publishStatus();
      return this._send({ type: 'presence-artwork', ...artifact });
    }, { isAvailable: () => !this.closed && this.socket?.readyState === WebSocket.OPEN,
      onScopeChange: () => this._publishStatus() });
    if (streamManager) streamManager.presenceArtwork = this.artwork;
    this.occupantTimer = null;
    this.onVoiceStateUpdate = () => {
      if (this.closed || !this.socket || this.occupantTimer) return;
      this.occupantTimer = setTimeout(() => {
        this.occupantTimer = null;
        const result = this.control?.channelDiscovery?.cached();
        if (result && this.socket?.readyState === WebSocket.OPEN) this._send({ type: 'available-channels',
          channels: result.availableChannels, channelsTruncated: result.channelsTruncated === true });
      }, 1000);
      this.occupantTimer.unref?.();
    };
    this.streamManager?.client?.on?.('voiceStateUpdate', this.onVoiceStateUpdate);
  }

  get enabled() { return !!(this.url && this.secret); }

  start() {
    if (!this.enabled || this.closed || this.socket) return;
    let socket;
    try {
      socket = new WebSocket(this.url, { headers: { Authorization: `Bearer ${this.secret}` }, maxPayload: BROKER_MAX_PAYLOAD });
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
        profile: ownProfile(this.streamManager?.client?.user, this.streamManager),
        capabilities: CAPABILITIES,
        status: this.streamManager.status(), videoQuality: this.streamManager.videoQuality?.(), queueLimit: this.streamManager.queueLimit, queueGapSeconds: this.streamManager.queueGapSeconds,
      contentAwareImagePreview: this.streamManager.contentAwareImagePreview === true,
        contentSnapshotPreview: this.streamManager.contentSnapshotPreview === true,
      deriveNicknameFromContent: this.streamManager.deriveNicknameFromContent === true,
        musicMode: this.streamManager.musicMode === true
      });
      this.artwork.reconnect();
      void this._publishAvailableChannels(socket);
      this.statusTimer = setInterval(() => {
        this._publishStatus();
        this.artwork.sync();
      }, 5000);
      this.statusTimer.unref?.();
    });
    socket.on('message', raw => void this._message(raw));
    socket.on('error', error => this.log(`[streambot:${this.workerId}] broker error: ${error.message}`));
    socket.on('close', () => {
      this.artwork.flight?.controller.abort();
      this.artwork.artifact = null;
      this.artwork.scope = null;
      if (this.socket === socket) this.socket = null;
      clearTimeout(this.occupantTimer); this.occupantTimer = null;
      clearInterval(this.statusTimer);
      this.statusTimer = null;
      this._scheduleReconnect();
    });
  }

  async _publishAvailableChannels(socket) {
    try {
      const result = await this.control.execute('list-channels', { refresh: true });
      if (this.socket === socket && socket.readyState === WebSocket.OPEN && result?.ok) {
        this._send({ type: 'available-channels', channels: result.availableChannels || [],
          channelsTruncated: result.channelsTruncated === true });
      }
    } catch (error) { this.log(`[streambot:${this.workerId}] channel discovery failed: ${error.message}`); }
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
    if (this._send(response) && message.operation !== 'list-channels') {
      this.results.set(message.requestId, response);
      if (this.results.size > 100) this.results.delete(this.results.keys().next().value);
    }
    this._publishStatus();
    this.artwork.sync();
  }

  _publishStatus() {
    return this._send({ type: 'status', status: this.streamManager.status(),
      profile: ownProfile(this.streamManager?.client?.user, this.streamManager),
      videoQuality: this.streamManager.videoQuality?.(), queueLimit: this.streamManager.queueLimit, queueGapSeconds: this.streamManager.queueGapSeconds,
      contentAwareImagePreview: this.streamManager.contentAwareImagePreview === true,
        contentSnapshotPreview: this.streamManager.contentSnapshotPreview === true,
      deriveNicknameFromContent: this.streamManager.deriveNicknameFromContent === true,
        musicMode: this.streamManager.musicMode === true });
  }

  close() {
    this.closed = true;
    this.artwork.close();
    clearTimeout(this.occupantTimer);
    this.occupantTimer = null;
    this.streamManager?.client?.off?.('voiceStateUpdate', this.onVoiceStateUpdate);
    clearTimeout(this.reconnectTimer);
    clearInterval(this.statusTimer);
    this.socket?.terminate();
    this.socket = null;
  }
}

module.exports = { StreamBrokerClient, CAPABILITIES };
