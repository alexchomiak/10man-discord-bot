'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WORKER_ID = /^[A-Za-z0-9_-]{1,32}$/;
const DISCORD_ID = /^\d{17,20}$/;
const ACTIONS = new Set(['play', 'join', 'move', 'stop', 'skip', 'scrub', 'pause', 'resume', 'catchup', 'toggle-overlay', 'reorder', 'set-name']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function sameToken(expected, actual) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(actual || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sameAnswer(expected, actual) {
  return sameToken(String(expected || '').trim().toLocaleLowerCase('en-US'),
    String(actual || '').trim().toLocaleLowerCase('en-US'));
}

function publicStatus(status) {
  if (!status) return null;
  const item = value => value && ({ id: value.id, title: value.title,
    isFiller: !!value.isFiller, isLive: !!value.isLive,
    durationSec: Number.isFinite(value.durationSec) ? value.durationSec : null });
  return { guildId: status.guildId, channelId: status.channelId,
    title: status.title, alive: !!status.alive, paused: !!status.paused,
    isFiller: !!status.isFiller, isLive: !!status.isLive,
    positionSec: status.positionSec, progressOverlay: !!status.progressOverlay,
    current: item(status.current), queue: Array.isArray(status.queue) ? status.queue.map(item) : [],
    stats: status.stats || null };
}

function createStreamDashboard({ broker, client, token, secretQuestion, secretAnswer, configuredWorkerIds = [], host = '0.0.0.0', port = 8082,
  staticDir = path.resolve(__dirname, '../web/dist'), log = console.log } = {}) {
  if (!secretAnswer && !token) return null;
  const profileCache = new Map();
  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(body));
  };
  const readBody = req => new Promise((resolve, reject) => {
    let size = 0; let oversized = false; const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 16 * 1024) { oversized = true; return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversized) { reject(new Error('Request too large.')); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('Invalid JSON.')); }
    });
    req.on('error', reject);
  });
  async function profile(userId, guildId) {
    const key = `${guildId || ''}:${userId}`;
    const cached = profileCache.get(key);
    if (cached && Date.now() - cached.at < 60000) return cached.value;
    const user = await client.users.fetch(userId, { force: true })
      .catch(() => client.users.cache.get(userId) || null);
    let nickname = null;
    if (guildId) {
      const guild = client.guilds.cache.get(guildId);
      const member = guild && await guild.members.fetch(userId, { force: true })
        .catch(() => guild.members.cache.get(userId) || null);
      nickname = member?.nickname || null;
    }
    const value = { displayName: nickname || user?.globalName || user?.username || userId,
      globalName: user?.globalName || null,
      nickname, avatarUrl: user?.displayAvatarURL?.({ extension: 'png', size: 128 }) || null };
    profileCache.set(key, { at: Date.now(), value });
    return value;
  }
  async function setName(workerId, name, guildId) {
    const worker = broker.getWorker(workerId);
    if (!worker?.userId) throw new Error(`Streambot '${workerId}' is offline.`);
    let globalError = null;
    try {
      const result = await broker.request('set-global-name', { name }, workerId);
      if (result.ok) {
        profileCache.clear();
        return { ok: true, message: result.message, scope: 'global' };
      }
      globalError = result.message;
    } catch (error) { globalError = error.message; }
    const guild = guildId && (client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null));
    if (!guild) throw new Error(`Global name failed (${globalError || 'unknown'}). Choose a server for nickname fallback.`);
    const member = await guild.members.fetch(worker.userId);
    if (member.manageable === false) throw new Error(`Global name failed (${globalError || 'unknown'}). CS bot cannot manage this member's nickname.`);
    await member.setNickname(name, 'Stream dashboard name change');
    profileCache.clear();
    return { ok: true, message: `Nickname changed to ${name} in ${guild.name}.`, scope: 'guild' };
  }
  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'GET' && url.pathname === '/api/auth-question') {
        return json(res, 200, { question: secretAnswer ? secretQuestion || 'What is the password?' : 'Dashboard password' });
      }
      const auth = String(req.headers.authorization || '');
      const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (secretAnswer ? !sameAnswer(secretAnswer, supplied) : !sameToken(token, supplied)) {
        return json(res, 401, { error: 'Incorrect answer.' });
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const guildId = url.searchParams.get('guildId') || null;
        const online = new Map(broker.listWorkers().map(worker => [worker.id, worker]));
        const ids = [...new Set([broker.defaultWorkerId, ...configuredWorkerIds, ...online.keys()])];
        const workers = await Promise.all(ids.map(async id => ({
          id, online: online.has(id), userId: online.get(id)?.userId || null,
          connectedAt: online.get(id)?.connectedAt || null,
          status: publicStatus(online.get(id)?.status),
          profile: online.get(id)?.userId ? await profile(online.get(id).userId, guildId) : null
        })));
        const guilds = [...client.guilds.cache.values()].map(guild => ({ id: guild.id, name: guild.name }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return json(res, 200, { defaultWorkerId: broker.defaultWorkerId, workers, guilds });
      }
      const channelMatch = /^\/api\/guilds\/(\d{17,20})\/channels$/.exec(url.pathname);
      if (req.method === 'GET' && channelMatch) {
        const guild = client.guilds.cache.get(channelMatch[1]) || await client.guilds.fetch(channelMatch[1]).catch(() => null);
        if (!guild) return json(res, 404, { error: 'Server unavailable to the CS bot; use manual IDs.' });
        const channels = await guild.channels.fetch();
        return json(res, 200, { channels: [...channels.values()]
          .filter(channel => channel && (channel.type === 2 || channel.type === 13))
          .map(channel => ({ id: channel.id, name: channel.name, type: channel.type }))
          .sort((a, b) => a.name.localeCompare(b.name)) });
      }
      const actionMatch = /^\/api\/workers\/([A-Za-z0-9_-]{1,32})\/actions$/.exec(url.pathname);
      if (req.method === 'POST' && actionMatch) {
        const body = await readBody(req);
        const operation = String(body?.operation || '');
        if (!ACTIONS.has(operation)) return json(res, 400, { error: 'Unsupported action.' });
        const workerId = actionMatch[1];
        if (!WORKER_ID.test(workerId)) return json(res, 400, { error: 'Invalid worker ID.' });
        if (operation === 'set-name') {
          const name = String(body.name || '').trim();
          if (!name || name.length > 32 || !DISCORD_ID.test(String(body.guildId || ''))) {
            return json(res, 400, { error: 'Name (1–32 characters) and server ID are required.' });
          }
          return json(res, 200, await setName(workerId, name, String(body.guildId)));
        }
        const payload = { requestedBy: 'dashboard' };
        if (['play', 'join', 'move'].includes(operation)) {
          if (!DISCORD_ID.test(String(body.guildId || '')) || !DISCORD_ID.test(String(body.channelId || ''))) {
            return json(res, 400, { error: 'Valid server and voice channel IDs are required.' });
          }
          payload.guildId = String(body.guildId);
          payload.channelId = String(body.channelId);
        }
        if (operation === 'play') {
          const source = String(body.source || '').trim();
          if (!source || source.length > 2048) return json(res, 400, { error: 'Enter a media URL or ShareTV slug.' });
          payload.source = source;
        }
        if (operation === 'scrub') {
          const delta = Number(body.deltaSec);
          if (!Number.isFinite(delta) || !delta || Math.abs(delta) > 86400) {
            return json(res, 400, { error: 'Scrub offset must be within one day.' });
          }
          payload.deltaSec = delta;
        }
        if (operation === 'reorder') {
          if (!Array.isArray(body.ids) || body.ids.length > 50 || body.ids.some(id => typeof id !== 'string' || id.length > 64)) {
            return json(res, 400, { error: 'Invalid queue order.' });
          }
          payload.ids = body.ids;
        }
        const result = await broker.request(operation, payload, workerId);
        return json(res, result.ok ? 200 : 409, { ok: !!result.ok, message: result.message,
          status: publicStatus(result.status), detail: result.detail || null });
      }
      return json(res, 404, { error: 'Not found.' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
    const filename = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
    if (filename.includes('..') || !/^[A-Za-z0-9_./-]+$/.test(filename)) return json(res, 404, { error: 'Not found.' });
    const file = path.join(staticDir, filename);
    if (!file.startsWith(`${staticDir}${path.sep}`)) return json(res, 404, { error: 'Not found.' });
    let data;
    try { data = await fs.promises.readFile(file); }
    catch { return json(res, 404, { error: 'Dashboard assets unavailable; build the web app.' }); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': filename === 'index.html' ? 'no-store' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; img-src 'self' https://cdn.discordapp.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
    if (req.method === 'HEAD') res.end(); else res.end(data);
  }
  const server = http.createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (res.headersSent) { res.destroy(); return; }
      json(res, error.message === 'Invalid JSON.' || error.message === 'Request too large.' ? 400 : 500,
        { error: error.message || 'Dashboard request failed.' });
    });
  });
  return {
    server,
    listen() { server.listen(port, host, () => log(`[stream-dashboard] listening on http://${host}:${server.address().port}`)); },
    close() { return new Promise(resolve => server.close(resolve)); }
  };
}

module.exports = { createStreamDashboard, publicStatus, sameToken, sameAnswer };
