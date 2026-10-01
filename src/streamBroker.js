'use strict';

const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const WORKER_ID = /^[A-Za-z0-9_-]{1,32}$/;
const DISCORD_USER_ID = /^\d{17,20}$/;
const ACCESS_CODE = /^[a-z]{6}$/;

function secretMatches(expected, actual) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(actual || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function workerProfile(value) {
  if (!value || typeof value !== 'object') return null;
  const name = key => typeof value[key] === 'string' && value[key].length <= 100 ? value[key] : null;
  let avatarUrl = null;
  try {
    const url = new URL(value.avatarUrl);
    if (url.protocol === 'https:' && ['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) {
      avatarUrl = url.href;
    }
  } catch { /* no avatar */ }
  return { displayName: name('displayName'), globalName: name('globalName'),
    username: name('username'), avatarUrl };
}

function workerExternalChannels(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap(channel => {
    if (!channel || !DISCORD_USER_ID.test(String(channel.guildId || '')) ||
        !DISCORD_USER_ID.test(String(channel.id || '')) ||
        typeof channel.guildName !== 'string' || typeof channel.name !== 'string' ||
        ![2, 13, 'GUILD_VOICE', 'GUILD_STAGE_VOICE'].includes(channel.type)) return [];
    return [{ guildId: channel.guildId, guildName: channel.guildName.slice(0, 100),
      id: channel.id, name: channel.name.slice(0, 100), type: channel.type, external: true }];
  });
}

class StreamBroker {
  constructor({ host = '0.0.0.0', port = 8090, secret, defaultWorkerId = 'primary', requestTimeoutMs = 60000, log = console.log } = {}) {
    this.host = host;
    this.port = port;
    this.secret = secret;
    this.defaultWorkerId = defaultWorkerId || 'primary';
    this.requestTimeoutMs = requestTimeoutMs;
    this.log = log;
    this.workers = new Map();
    this.pending = new Map();
    this.server = null;
    this.heartbeat = null;
  }

  get enabled() { return !!this.secret; }

  start() {
    if (!this.enabled || this.server) return this.server;
    this.server = new WebSocketServer({ host: this.host, port: this.port, maxPayload: 64 * 1024 });
    this.server.on('connection', (socket, request) => this._connection(socket, request));
    this.server.on('listening', () => {
      const address = this.server.address();
      if (address && typeof address === 'object') this.port = address.port;
      this.log(`[stream-broker] listening on ws://${this.host}:${this.port}`);
    });
    this.server.on('error', error => console.error('[stream-broker] server error:', error.message));
    this.heartbeat = setInterval(() => {
      for (const worker of this.workers.values()) {
        if (!worker.socket.isAlive) { worker.socket.terminate(); continue; }
        worker.socket.isAlive = false;
        worker.socket.ping();
      }
    }, 15000);
    this.heartbeat.unref?.();
    return this.server;
  }

  _connection(socket, request) {
    const auth = String(request.headers.authorization || '');
    const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!secretMatches(this.secret, supplied)) {
      socket.close(1008, 'unauthorized');
      return;
    }
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });
    const registerTimer = setTimeout(() => socket.close(1008, 'registration required'), 5000);
    registerTimer.unref?.();
    socket.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { socket.close(1003, 'invalid JSON'); return; }
      if (message.type === 'register') {
        const id = String(message.workerId || '');
        if (!WORKER_ID.test(id)) { socket.close(1008, 'invalid worker id'); return; }
        if (this.workers.has(id)) { socket.close(1008, 'duplicate worker id'); return; }
        clearTimeout(registerTimer);
        socket.workerId = id;
        const userId = String(message.userId || '');
        if (!DISCORD_USER_ID.test(userId)) { socket.close(1008, 'invalid Discord user id'); return; }
        const accessCode = String(message.accessCode || '');
        if (!ACCESS_CODE.test(accessCode) || [...this.workers.values()].some(worker => worker.accessCode === accessCode)) {
          socket.close(1008, 'invalid or duplicate access code'); return;
        }
        this.workers.set(id, { id, userId, socket, status: message.status || null,
          profile: workerProfile(message.profile),
          accessCode, musicMode: message.musicMode === true, capabilities: message.capabilities || [],
          externalChannels: [], connectedAt: Date.now() });
        this.log(`[stream-broker] worker connected: ${id}`);
        return;
      }
      if (!socket.workerId) return;
      const worker = this.workers.get(socket.workerId);
      if (message.type === 'status' && worker) {
        worker.status = message.status || null;
        worker.musicMode = message.musicMode === true;
        if (message.profile) worker.profile = workerProfile(message.profile);
      }
      if (message.type === 'external-channels' && worker) {
        worker.externalChannels = workerExternalChannels(message.channels);
      }
      if (message.type === 'result' && message.requestId) {
        const pending = this.pending.get(message.requestId);
        if (pending && pending.workerId === socket.workerId) {
          clearTimeout(pending.timer);
          this.pending.delete(message.requestId);
          if (worker && message.result && Object.hasOwn(message.result, 'status')) {
            worker.status = message.result.status;
            worker.musicMode = message.result.musicMode === true;
          }
          pending.resolve(message.result || { ok: false, message: 'Worker returned no result.' });
        }
      }
    });
    socket.on('close', () => {
      clearTimeout(registerTimer);
      const id = socket.workerId;
      if (id && this.workers.get(id)?.socket === socket) {
        this.workers.delete(id);
        this.log(`[stream-broker] worker disconnected: ${id}`);
        for (const [requestId, pending] of this.pending) {
          if (pending.workerId !== id) continue;
          clearTimeout(pending.timer);
          this.pending.delete(requestId);
          pending.reject(new Error(`Streambot '${id}' disconnected.`));
        }
      }
    });
  }

  listWorkers() {
    return [...this.workers.values()].map(({ id, userId, status, profile, musicMode, capabilities, externalChannels, connectedAt }) => ({ id, userId, status, profile, musicMode, capabilities, externalChannels, connectedAt }));
  }

  getWorker(requested) {
    const workerId = this.resolveWorkerId(requested);
    const worker = this.workers.get(workerId);
    if (!worker || worker.socket.readyState !== WebSocket.OPEN) return null;
    const { id, userId, status, profile, musicMode, capabilities, externalChannels, connectedAt } = worker;
    return { id, userId, status, profile, musicMode, capabilities, externalChannels, connectedAt };
  }

  getWorkerByAccessCode(code) {
    if (!ACCESS_CODE.test(code || '')) return null;
    for (const worker of this.workers.values()) {
      if (worker.accessCode === code && worker.socket.readyState === WebSocket.OPEN) {
        const { id, userId, status, profile, musicMode, connectedAt } = worker;
        return { id, userId, status, profile, musicMode, connectedAt };
      }
    }
    return null;
  }

  resolveWorkerId(requested) {
    return String(requested || this.defaultWorkerId || 'primary');
  }

  async request(operation, payload = {}, requestedWorkerId) {
    const workerId = this.resolveWorkerId(requestedWorkerId);
    const worker = this.workers.get(workerId);
    if (!worker || worker.socket.readyState !== WebSocket.OPEN) {
      const connected = [...this.workers.keys()];
      const detail = connected.length ? ` Connected workers: ${connected.join(', ')}.` : ' No workers are connected to the broker.';
      throw new Error(`Streambot '${workerId}' is offline.${detail}`);
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Streambot '${workerId}' timed out handling ${operation}.`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { workerId, resolve, reject, timer });
      worker.socket.send(JSON.stringify({ type: 'command', requestId, operation, payload }));
    });
  }

  async close() {
    clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const worker of this.workers.values()) worker.socket.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Stream broker shut down.'));
    }
    this.pending.clear();
    this.workers.clear();
    if (!this.server) return;
    await new Promise(resolve => this.server.close(resolve));
    this.server = null;
  }
}

module.exports = { StreamBroker, WORKER_ID };
