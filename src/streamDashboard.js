'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WORKER_ID = /^[A-Za-z0-9_-]{1,32}$/;
const DISCORD_ID = /^\d{17,20}$/;
const ACTIONS = new Set(['play', 'join', 'move', 'stop', 'skip', 'scrub', 'seek', 'pause', 'resume', 'catchup', 'toggle-overlay', 'toggle-music-mode', 'reorder', 'remove-queued', 'set-name']);
const PUBLIC_ACTIONS = new Set(['play', 'skip', 'scrub', 'seek', 'pause', 'resume', 'reorder', 'remove-queued']);
const ACCESS_CODE = /^[a-z]{6}$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function parseExternalChannels(value) {
  const seen = new Set();
  return String(value || '').split(',').map(entry => entry.trim()).flatMap(entry => {
    const match = /^(\d{17,20}):(\d{17,20})$/.exec(entry);
    if (!match || seen.has(entry)) return [];
    seen.add(entry);
    return [{ guildId: match[1], id: match[2] }];
  });
}

function sameToken(expected, actual) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(actual || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicStatus(status) {
  if (!status) return null;
  const item = value => value && ({ id: value.id, title: value.title,
    thumbnail: value.thumbnail || null,
    isFiller: !!value.isFiller, isLive: !!value.isLive,
    durationSec: Number.isFinite(value.durationSec) ? value.durationSec : null });
  return { guildId: status.guildId, channelId: status.channelId,
    title: status.title, alive: !!status.alive, paused: !!status.paused,
    isFiller: !!status.isFiller, isLive: !!status.isLive,
    positionSec: status.positionSec, progressOverlay: !!status.progressOverlay,
    musicMode: !!status.musicMode,
    musicChapters: Array.isArray(status.musicChapters) ? status.musicChapters.map(chapter => ({
      title: chapter.title, startSec: chapter.startSec, endSec: chapter.endSec })) : null,
    currentChapter: status.currentChapter && { title: status.currentChapter.title,
      startSec: status.currentChapter.startSec, endSec: status.currentChapter.endSec,
      index: status.currentChapter.index },
    current: item(status.current), queue: Array.isArray(status.queue) ? status.queue.map(item) : [],
    stats: status.stats || null };
}

function scopedStatus(status) {
  const value = publicStatus(status);
  if (!value) return null;
  const safeThumbnail = item => {
    if (!item?.thumbnail) return;
    try {
      const url = new URL(item.thumbnail);
      const sensitive = [...url.searchParams.keys()].some(key => /^(api.?key|token|access.?token|auth|key)$/i.test(key));
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || sensitive) item.thumbnail = null;
    } catch { item.thumbnail = null; }
  };
  safeThumbnail(value.current);
  value.queue.forEach(safeThumbnail);
  delete value.guildId;
  delete value.channelId;
  delete value.stats;
  value.inVoiceChannel = !!(status.guildId && status.channelId);
  return value;
}

function createStreamDashboard({ broker, client, password, token, randomCodes = false, configuredWorkerIds = [], channelIds = [], externalChannels = [], host = '0.0.0.0', port = 8082,
  staticDir = path.resolve(__dirname, '../web/dist'), log = console.log } = {}) {
  const adminPassword = password || token;
  if (!adminPassword) return null;
  const publicWorkerFor = publicId => {
    if (!(randomCodes ? ACCESS_CODE : WORKER_ID).test(publicId || '')) return null;
    const worker = randomCodes ? broker.getWorkerByAccessCode?.(publicId) : broker.getWorker?.(publicId);
    const status = worker?.status;
    return status?.alive === true && status?.inChannel === true &&
      DISCORD_ID.test(String(status.guildId || '')) && DISCORD_ID.test(String(status.channelId || ''))
      ? worker : null;
  };
  const profileCache = new Map();
  const invalidCodes = new Map();
  const authFailures = new Map();
  const recordFailure = (req, attempts) => {
    const key = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    if (!attempts.has(key) && attempts.size >= 1000) attempts.delete(attempts.keys().next().value);
    const previous = attempts.get(key);
    const count = previous && now - previous.since < 60000 ? previous.count + 1 : 1;
    attempts.set(key, { count, since: previous && now - previous.since < 60000 ? previous.since : now });
    return count;
  };
  const invalidCodeResponse = (req, res) => {
    const count = recordFailure(req, invalidCodes);
    return json(res, count > 30 ? 429 : 404, { error: count > 30 ? 'Too many invalid links.' : 'Link expired or unavailable.' });
  };
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
      const scopedMatch = /^\/api\/public\/([A-Za-z0-9_-]{1,32})\/(state|actions)$/.exec(url.pathname);
      let scopedWorker = null;
      if (scopedMatch) {
        scopedWorker = publicWorkerFor(scopedMatch[1]);
        if (!scopedWorker) return invalidCodeResponse(req, res);
        if (req.method === 'GET' && scopedMatch[2] === 'state') {
          const workerProfile = scopedWorker.userId ? await profile(scopedWorker.userId, scopedWorker.status?.guildId) : null;
          const current = publicWorkerFor(scopedMatch[1]);
          if (!current || current.connectedAt !== scopedWorker.connectedAt) return json(res, 404, { error: 'Player unavailable.' });
          return json(res, 200, { worker: { id: scopedWorker.id, online: true,
            musicMode: scopedWorker.musicMode === true,
            status: scopedStatus(scopedWorker.status),
            profile: workerProfile } });
        }
        if (req.method !== 'POST' || scopedMatch[2] !== 'actions') return json(res, 405, { error: 'Method not allowed.' });
      } else {
        const auth = String(req.headers.authorization || '');
        const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        if (!sameToken(adminPassword, supplied)) {
          const count = recordFailure(req, authFailures);
          return json(res, count > 30 ? 429 : 401,
            { error: count > 30 ? 'Too many password attempts.' : 'Incorrect password.' });
        }
        authFailures.delete(req.socket.remoteAddress || 'unknown');
      }
      if (!scopedWorker && req.method === 'GET' && url.pathname === '/api/state') {
        const guildId = url.searchParams.get('guildId') || null;
        const online = new Map(broker.listWorkers().map(worker => [worker.id, worker]));
        const ids = [...new Set([broker.defaultWorkerId, ...configuredWorkerIds, ...online.keys()])];
        const workers = await Promise.all(ids.map(async id => ({
          id, online: online.has(id), userId: online.get(id)?.userId || null,
          connectedAt: online.get(id)?.connectedAt || null,
          status: publicStatus(online.get(id)?.status),
          musicMode: online.get(id)?.musicMode === true,
          profile: online.get(id)?.userId ? await profile(online.get(id).userId, guildId) : null
        })));
        const guilds = [...client.guilds.cache.values()].map(guild => ({ id: guild.id, name: guild.name }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return json(res, 200, { defaultWorkerId: broker.defaultWorkerId, workers, guilds });
      }
      const channelMatch = /^\/api\/guilds\/(\d{17,20})\/channels$/.exec(url.pathname);
      if (!scopedWorker && req.method === 'GET' && channelMatch) {
        const guild = client.guilds.cache.get(channelMatch[1]) || await client.guilds.fetch(channelMatch[1]).catch(() => null);
        if (!guild) return json(res, 404, { error: 'Server unavailable to the CS bot; use manual IDs.' });
        const channels = await guild.channels.fetch();
        const allowed = new Set(channelIds);
        const local = [...channels.values()]
          .filter(channel => channel && (channel.type === 2 || channel.type === 13) &&
            (!allowed.size || allowed.has(channel.id)))
          .map(channel => ({ guildId: guild.id, guildName: guild.name,
            id: channel.id, name: channel.name, type: channel.type, external: false }))
          .sort((a, b) => a.name.localeCompare(b.name));
        const external = await Promise.all(externalChannels.map(async entry => {
          if (entry.guildId === guild.id && local.some(channel => channel.id === entry.id)) return null;
          const otherGuild = client.guilds.cache.get(entry.guildId)
            || await client.guilds.fetch(entry.guildId).catch(() => null);
          const channel = otherGuild && await otherGuild.channels.fetch(entry.id).catch(() => null);
          return { guildId: entry.guildId, guildName: otherGuild?.name || entry.guildId,
            id: entry.id, name: channel?.name || entry.id, type: channel?.type || null,
            external: true };
        }));
        return json(res, 200, { channels: [...local, ...external.filter(Boolean)] });
      }
      const actionMatch = scopedWorker ? [null, scopedWorker.id] : /^\/api\/workers\/([A-Za-z0-9_-]{1,32})\/actions$/.exec(url.pathname);
      if (req.method === 'POST' && actionMatch) {
        const body = await readBody(req);
        const operation = String(body?.operation || '');
        if (!(scopedWorker ? PUBLIC_ACTIONS : ACTIONS).has(operation)) return json(res, 403, { error: 'Action not available on this page.' });
        const workerId = actionMatch[1];
        if (!WORKER_ID.test(workerId)) return json(res, 400, { error: 'Invalid worker ID.' });
        if (operation === 'set-name') {
          const name = String(body.name || '').trim();
          if (!name || name.length > 32 || !DISCORD_ID.test(String(body.guildId || ''))) {
            return json(res, 400, { error: 'Name (1–32 characters) and server ID are required.' });
          }
          return json(res, 200, await setName(workerId, name, String(body.guildId)));
        }
        const payload = { requestedBy: scopedWorker ? 'public-link' : 'dashboard' };
        if (['play', 'join', 'move'].includes(operation)) {
          const targetGuild = scopedWorker ? scopedWorker.status?.guildId : body.guildId;
          const targetChannel = scopedWorker ? scopedWorker.status?.channelId : body.channelId;
          if (!DISCORD_ID.test(String(targetGuild || '')) || !DISCORD_ID.test(String(targetChannel || ''))) {
            return json(res, 400, { error: 'Valid server and voice channel IDs are required.' });
          }
          payload.guildId = String(targetGuild);
          payload.channelId = String(targetChannel);
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
        if (operation === 'seek') {
          const position = Number(body.positionSec);
          if (!Number.isFinite(position) || position < 0 || position > 7 * 86400) {
            return json(res, 400, { error: 'Invalid seek position.' });
          }
          payload.positionSec = position;
        }
        if (operation === 'reorder') {
          if (!Array.isArray(body.ids) || body.ids.length > 50 || body.ids.some(id => typeof id !== 'string' || id.length > 64)) {
            return json(res, 400, { error: 'Invalid queue order.' });
          }
          payload.ids = body.ids;
        }
        if (operation === 'remove-queued') {
          if (typeof body.queueId !== 'string' || !/^[a-f0-9-]{36}$/i.test(body.queueId)) {
            return json(res, 400, { error: 'Invalid queue item ID.' });
          }
          payload.queueId = body.queueId;
        }
        if (scopedWorker) {
          const current = publicWorkerFor(scopedMatch[1]);
          if (!current || current.id !== workerId || current.connectedAt !== scopedWorker.connectedAt) {
            return json(res, 404, { error: 'Player unavailable.' });
          }
        }
        const result = await broker.request(operation, payload, workerId);
        return json(res, result.ok ? 200 : 409, { ok: !!result.ok, message: result.message,
          status: scopedWorker ? scopedStatus(result.status) : publicStatus(result.status),
          detail: scopedWorker ? null : result.detail || null });
      }
      return json(res, 404, { error: 'Not found.' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
    const publicId = /^\/([A-Za-z0-9_-]{1,32})$/.exec(url.pathname)?.[1];
    if (publicId && !publicWorkerFor(publicId)) return invalidCodeResponse(req, res);
    const filename = url.pathname === '/' || publicId ? 'index.html' : url.pathname.replace(/^\//, '');
    if (filename.includes('..') || !/^[A-Za-z0-9_./-]+$/.test(filename)) return json(res, 404, { error: 'Not found.' });
    const file = path.join(staticDir, filename);
    if (!file.startsWith(`${staticDir}${path.sep}`)) return json(res, 404, { error: 'Not found.' });
    let data;
    try { data = await fs.promises.readFile(file); }
    catch { return json(res, 404, { error: 'Dashboard assets unavailable; build the web app.' }); }
    if (publicId && !publicWorkerFor(publicId)) return invalidCodeResponse(req, res);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': filename === 'index.html' ? 'no-store' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' https: http: data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
    if (req.method === 'HEAD') res.end();
    else if (publicId && filename === 'index.html') {
      res.end(data.toString('utf8').replace('</head>', `<meta name="stream-public-id" content="${publicId}" /></head>`));
    } else res.end(data);
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

module.exports = { createStreamDashboard, parseExternalChannels, publicStatus, scopedStatus, sameToken };
