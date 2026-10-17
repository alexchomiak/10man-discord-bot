'use strict';

const http = require('node:http');
const { brandDashboardHtml } = require('./streamBrand');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { StreamSchedules } = require('./streamSchedules');
const { searchYoutube: defaultSearchYoutube } = require('./youtubeSearch');
const { parseExternalChannels } = require('./externalChannels');
const { sanitizeAvailableChannels } = require('./workerChannels');
const { presenceText } = require('./streambot/presenceMetadata');
const { fetchPresenceArtwork } = require('./streambot/presenceArtwork');

const WORKER_ID = /^[A-Za-z0-9_-]{1,32}$/;
const DISCORD_ID = /^\d{17,20}$/;
const ACTIONS = new Set(['play', 'join', 'move', 'stop', 'skip', 'scrub', 'seek', 'pause', 'resume', 'catchup', 'toggle-overlay', 'toggle-music-mode', 'reorder', 'remove-queued', 'clear-queue', 'set-content-nickname', 'set-content-preview', 'set-queue-limit', 'set-queue-gap', 'set-name']);
const PUBLIC_ACTIONS = new Set(['toggle-music-mode', 'play', 'skip', 'scrub', 'seek', 'pause', 'resume', 'reorder', 'remove-queued', 'clear-queue']);
const ACCESS_CODE = /^[a-z]{6}$/;
const MAX_REORDER_ITEMS = 1000;
const MAX_ACTION_BODY_BYTES = 64 * 1024;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };

function sameToken(expected, actual) {
  const a = Buffer.from(String(expected || ''));
  const b = Buffer.from(String(actual || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

const SOURCE_KINDS = new Set(['youtube', 'twitch', 'jellyfin', 'sharetv', 'browser', 'direct']);
const displayText = (value, max = 500) => presenceText(typeof value === 'string' ? value.slice(0, 16000) : '').slice(0, max) || null;

function publicStatus(status) {
  if (!status) return null;
  const item = value => value && ({ id: value.id, title: value.title,
    thumbnail: value.thumbnail || null,
    sourceKind: SOURCE_KINDS.has(value.sourceKind) ? value.sourceKind : null,
    contentTitle: displayText(value.contentTitle), presenceTitle: displayText(value.presenceTitle),
    presenceDetails: displayText(value.presenceDetails, 1000),
    programmeDescription: displayText(value.programmeDescription, 1000),
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
    transition: status.current?.isFiller && !status.musicMode && status.transition?.kind === 'up-next' &&
      status.queue?.some(value => value && !value.isFiller) && Number.isFinite(status.current.durationSec) &&
      Number.isFinite(status.positionSec) ? { kind: 'up-next',
        remainingSec: Math.max(0, status.current.durationSec - status.positionSec) } : null,
    stats: status.stats || null };
}

function scopedStatus(status, thumbnailFor = null) {
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
  const sanitizeItem = item => {
    if (!item) return;
    item.title = displayText(item.title);
    if (thumbnailFor) item.thumbnail = thumbnailFor(item);
    else safeThumbnail(item);
  };
  sanitizeItem(value.current);
  value.queue.forEach(sanitizeItem);
  value.title = displayText(value.title);
  if (value.musicChapters) value.musicChapters.forEach(chapter => { chapter.title = displayText(chapter.title); });
  if (value.currentChapter) value.currentChapter.title = displayText(value.currentChapter.title);
  delete value.guildId;
  delete value.channelId;
  delete value.stats;
  value.inVoiceChannel = !!(status.guildId && status.channelId);
  return value;
}

function createStreamDashboard({ broker, client, password, token, randomCodes = false, configuredWorkerIds = [], channelIds = [], serverIds = [], host = '0.0.0.0', port = 8082,
  scheduleFilePath = null, scheduleConfig = {}, staticDir = path.resolve(__dirname, '../web/dist'), log = console.log, searchYoutube = defaultSearchYoutube, fetchThumbnail = (url, signal) => fetchPresenceArtwork(url, signal, { preserveAspect: true }) } = {}) {
  const adminPassword = password || token;
  if (!adminPassword) return null;
  const schedules = new StreamSchedules({ broker, filePath: scheduleFilePath, log });
  const publicWorkerFor = publicId => {
    if (!(randomCodes ? ACCESS_CODE : WORKER_ID).test(publicId || '')) return null;
    const worker = randomCodes ? broker.getWorkerByAccessCode?.(publicId) : broker.getWorker?.(publicId);
    const status = worker?.status;
    return status?.alive === true && status?.inChannel === true &&
      DISCORD_ID.test(String(status.guildId || '')) && DISCORD_ID.test(String(status.channelId || ''))
      ? worker : null;
  };
  // Opaque URLs are derived from active worker state; requests never supply an upstream URL.
  const thumbnailSecret = crypto.randomBytes(32);
  const thumbnailKey = (worker, item) => item?.thumbnail && typeof item.thumbnail === 'string' && item.thumbnail.length <= 8192
    ? crypto.createHmac('sha256', thumbnailSecret).update(JSON.stringify([worker.id, worker.connectedAt,
      worker.status?.guildId, worker.status?.channelId, item.id, item.thumbnail])).digest('hex').slice(0, 32) : null;
  const scopedFor = (worker, publicId, status = worker.status) => scopedStatus(status, item => {
    const key = thumbnailKey(worker, item);
    return key ? `/api/public/${publicId}/thumbnail/${key}.jpg` : null;
  });
  const thumbnailCache = new Map();
  const thumbnailFlights = new Map();
  let thumbnailActive = 0;
  const findThumbnail = (worker, key) => [worker.status?.current, ...(worker.status?.queue || [])]
    .find(item => thumbnailKey(worker, item) === key);
  const thumbnailPending = [];
  const thumbnailAbort = new AbortController();
  const THUMBNAIL_BUSY = Symbol('thumbnail-busy');
  const pumpThumbnails = () => {
    while (thumbnailActive < 3 && thumbnailPending.length && !thumbnailAbort.signal.aborted) {
      const job = thumbnailPending.shift();
      thumbnailActive++;
      Promise.resolve().then(() => {
        const current = publicWorkerFor(job.publicId);
        return current && current.connectedAt === job.worker.connectedAt && findThumbnail(current, job.key)
          ? fetchThumbnail(job.item.thumbnail, thumbnailAbort.signal) : null;
      }).then(bytes => {
        if (!Buffer.isBuffer(bytes) || bytes.length > 256 * 1024) bytes = null;
        if (!thumbnailAbort.signal.aborted) {
          if (thumbnailCache.size >= 32) {
            // Keep active current posters where possible: signed upstream URLs may expire
            // long before their programme ends. The opaque key changes with the URL.
            const evict = [...thumbnailCache].find(([key, cached]) => {
              const worker = publicWorkerFor(cached.publicId);
              return !worker || thumbnailKey(worker, worker.status?.current) !== key;
            })?.[0] || thumbnailCache.keys().next().value;
            thumbnailCache.delete(evict);
          }
          thumbnailCache.set(job.key, { at: Date.now(), bytes, publicId: job.publicId });
        }
        job.resolve(bytes);
      }).catch(() => job.resolve(null)).finally(() => {
        thumbnailActive--; thumbnailFlights.delete(job.key); pumpThumbnails();
      });
    }
  };
  const loadThumbnail = (worker, publicId, key, item) => {
    const cached = thumbnailCache.get(key);
    if (cached && (cached.bytes || Date.now() - cached.at < 5000)) {
      thumbnailCache.delete(key); thumbnailCache.set(key, cached);
      return cached.bytes;
    }
    if (cached) thumbnailCache.delete(key);
    if (thumbnailFlights.has(key)) return thumbnailFlights.get(key);
    if (thumbnailAbort.signal.aborted || thumbnailPending.length >= 64) return THUMBNAIL_BUSY;
    let resolve;
    const flight = new Promise(done => { resolve = done; });
    thumbnailFlights.set(key, flight);
    thumbnailPending.push({ worker, publicId, key, item, resolve });
    pumpThumbnails();
    return flight;
  };
  const invalidCodes = new Map();
  const authFailures = new Map();
  const publicSearches = new Map();
  let searchesInFlight = 0;
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
      if (size > MAX_ACTION_BODY_BYTES) { oversized = true; return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversized) { reject(new Error('Request too large.')); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('Invalid JSON.')); }
    });
    req.on('error', reject);
  });
  const populatedServerIds = new Set(serverIds);
  const availableFor = worker => sanitizeAvailableChannels(worker?.availableChannels)
    .filter(channel => !populatedServerIds.size || populatedServerIds.has(channel.guildId));
  function profile(userId, guildId, reported = null) {
    // The worker reports its own identity at login. Local Discord caches can
    // provide a server nickname, but state polling never waits on REST.
    const user = client.users.cache.get(userId) || null;
    let nickname = null;
    if (guildId) {
      const guild = client.guilds.cache.get(guildId);
      const member = guild?.members.cache.get(userId) || null;
      nickname = member?.nickname || null;
    }
    if (reported?.guildId === guildId) nickname = reported.nickname || null;
    return { displayName: nickname || reported?.displayName || user?.globalName || user?.username || userId,
      globalName: reported?.globalName || user?.globalName || null,
      nickname,
      avatarUrl: reported?.avatarUrl || user?.displayAvatarURL?.({ extension: 'png', size: 128 }) || null };
  }
  async function setName(workerId, name, guildId) {
    const worker = broker.getWorker(workerId);
    if (!worker?.userId) throw new Error(`Streambot '${workerId}' is offline.`);
    let globalError = null;
    try {
      const result = await broker.request('set-global-name', { name }, workerId);
      if (result.ok) {
        return { ok: true, message: result.message, scope: 'global' };
      }
      globalError = result.message;
    } catch (error) { globalError = error.message; }
    const guild = guildId && (client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null));
    if (!guild) throw new Error(`Global name failed (${globalError || 'unknown'}). Choose a server for nickname fallback.`);
    const member = await guild.members.fetch(worker.userId);
    if (member.manageable === false) throw new Error(`Global name failed (${globalError || 'unknown'}). CS bot cannot manage this member's nickname.`);
    await member.setNickname(name, 'Stream dashboard name change');
    return { ok: true, message: `Nickname changed to ${name} in ${guild.name}.`, scope: 'guild' };
  }
  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const thumbnailMatch = /^\/api\/public\/([A-Za-z0-9_-]{1,32})\/thumbnail\/([a-f0-9]{32})\.jpg$/.exec(url.pathname);
      if (thumbnailMatch) {
        const worker = publicWorkerFor(thumbnailMatch[1]);
        const item = worker && !url.search && findThumbnail(worker, thumbnailMatch[2]);
        if (!item) return invalidCodeResponse(req, res);
        if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'Method not allowed.' });
        const bytes = await loadThumbnail(worker, thumbnailMatch[1], thumbnailMatch[2], item);
        const current = publicWorkerFor(thumbnailMatch[1]);
        if (!current || current.connectedAt !== worker.connectedAt || !findThumbnail(current, thumbnailMatch[2])) return invalidCodeResponse(req, res);
        if (bytes === THUMBNAIL_BUSY) {
          res.setHeader('Retry-After', '2');
          return json(res, 503, { error: 'Artwork busy. Try again shortly.' });
        }
        if (!bytes) return json(res, 404, { error: 'Artwork unavailable.' });
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': bytes.length,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        return res.end(req.method === 'HEAD' ? undefined : bytes);
      }
      const artworkMatch = /^\/api\/public\/([A-Za-z0-9_-]{1,32})\/artwork\/([a-f0-9]{32})\.jpg$/.exec(url.pathname);
      if (artworkMatch) {
        const worker = publicWorkerFor(artworkMatch[1]);
        const bytes = worker && !url.search && broker.getPresenceArtwork?.(worker.id, artworkMatch[2]);
        if (!bytes) return invalidCodeResponse(req, res);
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': bytes.length,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        return res.end(req.method === 'HEAD' ? undefined : bytes);
      }
      const scopedMatch = /^\/api\/public\/([A-Za-z0-9_-]{1,32})\/(state|actions|search)$/.exec(url.pathname);
      let scopedWorker = null;
      if (scopedMatch) {
        scopedWorker = publicWorkerFor(scopedMatch[1]);
        if (!scopedWorker) return invalidCodeResponse(req, res);
        if (req.method === 'GET' && scopedMatch[2] === 'state') {
          const workerProfile = scopedWorker.userId ? profile(scopedWorker.userId, scopedWorker.status?.guildId, scopedWorker.profile) : null;
          const current = publicWorkerFor(scopedMatch[1]);
          if (!current || current.connectedAt !== scopedWorker.connectedAt) return json(res, 404, { error: 'Player unavailable.' });
          return json(res, 200, { worker: { id: scopedWorker.id, online: true,
            musicMode: scopedWorker.musicMode === true,
            status: scopedFor(scopedWorker, scopedMatch[1]),
            profile: workerProfile } });
        }
        if (scopedMatch[2] !== 'search' && (req.method !== 'POST' || scopedMatch[2] !== 'actions')) {
          return json(res, 405, { error: 'Method not allowed.' });
        }
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
      if (!scopedWorker && url.pathname === '/api/schedules/sharetv-hint' && req.method === 'POST') {
        const body = await readBody(req);
        if (typeof body?.source !== 'string' || body.source.length > 2048) return json(res, 400, { error: 'Invalid source.' });
        const { getShareTvScheduleHint } = require('./streambot/sources');
        return json(res, 200, await getShareTvScheduleHint(body.source, scheduleConfig));
      }
      const scheduleMatch = !scopedWorker && /^\/api\/workers\/([A-Za-z0-9_-]{1,32})\/schedules(?:\/([a-f0-9-]{36}))?$/.exec(url.pathname);
      if (scheduleMatch) {
        const workerId = scheduleMatch[1];
        if (![broker.defaultWorkerId, ...configuredWorkerIds].includes(workerId) && !broker.getWorker(workerId) && !broker.knownWorkerIds?.has(workerId) && !schedules.list(workerId).length) return json(res, 404, { error: 'Unknown worker.' });
        if (req.method === 'GET' && !scheduleMatch[2]) return json(res, 200, { schedules: schedules.list(workerId) });
        if (req.method === 'POST' && !scheduleMatch[2]) {
          const body = await readBody(req);
          try { return json(res, 201, { schedule: await schedules.add(workerId, body) }); }
          catch (error) { return json(res, 400, { error: error.message }); }
        }
        if (req.method === 'PUT' && scheduleMatch[2]) {
          const body = await readBody(req);
          try {
            const schedule = await schedules.update(workerId, scheduleMatch[2], body);
            return json(res, schedule ? 200 : 404, schedule ? { schedule } : { error: 'Schedule not found.' });
          } catch (error) { return json(res, error.code === 'SCHEDULE_NOT_PENDING' ? 409 : 400, { error: error.message }); }
        }
        if (req.method === 'DELETE' && scheduleMatch[2]) {
          try { const result = await schedules.remove(workerId, scheduleMatch[2]); return json(res, result ? 200 : 404, result || { error: 'Schedule not found.' }); }
          catch (error) { return json(res, 409, { error: error.message }); }
        }
        return json(res, 405, { error: 'Method not allowed.' });
      }
      const searchMatch = scopedMatch?.[2] === 'search' ? [null, scopedWorker.id]
        : scopedWorker ? null : /^\/api\/workers\/([A-Za-z0-9_-]{1,32})\/search$/.exec(url.pathname);
      if (searchMatch) {
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
        if (!scopedWorker && !broker.getWorker(searchMatch[1])) return json(res, 404, { error: 'Worker unavailable.' });
        const query = String(url.searchParams.get('q') || '').trim();
        if (query.length < 2 || query.length > 120) return json(res, 400, { error: 'Search must be 2–120 characters.' });
        const page = Number(url.searchParams.get('page') || 1);
        if (!Number.isInteger(page) || page < 1 || page > 20) return json(res, 400, { error: 'Invalid search page.' });
        if (scopedWorker && recordFailure(req, publicSearches) > 20) {
          return json(res, 429, { error: 'Too many searches. Try again in a minute.' });
        }
        if (searchesInFlight >= 3) return json(res, 429, { error: 'Search is busy. Try again shortly.' });
        searchesInFlight++;
        try {
          const results = await searchYoutube(query, { page });
          if (scopedWorker) {
            const current = publicWorkerFor(scopedMatch[1]);
            if (!current || current.id !== scopedWorker.id || current.connectedAt !== scopedWorker.connectedAt) {
              return json(res, 404, { error: 'Player unavailable.' });
            }
          }
          return json(res, 200, { results });
        } catch (error) {
          return json(res, 502, { error: error.message || 'YouTube search failed.' });
        } finally { searchesInFlight--; }
      }
      if (!scopedWorker && req.method === 'GET' && url.pathname === '/api/state') {
        const guildId = url.searchParams.get('guildId') || null;
        const online = new Map(broker.listWorkers().map(worker => [worker.id, worker]));
        const ids = [...new Set([broker.defaultWorkerId, ...configuredWorkerIds, ...online.keys()])];
        const workers = await Promise.all(ids.map(async id => ({
          id, online: online.has(id), userId: online.get(id)?.userId || null,
          connectedAt: online.get(id)?.connectedAt || null,
          status: publicStatus(online.get(id)?.status),
          queueLimit: online.get(id)?.queueLimit || 100,
          queueGapSeconds: online.get(id)?.queueGapSeconds ?? 15,
          musicMode: online.get(id)?.musicMode === true,
          deriveNicknameFromContent: online.get(id)?.deriveNicknameFromContent === true,
          contentAwareImagePreview: online.get(id)?.contentAwareImagePreview === true,
          contentSnapshotPreview: online.get(id)?.contentSnapshotPreview === true,
          availableChannels: availableFor(online.get(id)),
          channelsTruncated: online.get(id)?.channelsTruncated === true,
          profile: online.get(id)?.userId ? profile(online.get(id).userId, guildId, online.get(id).profile) : null
        })));
        const guilds = [...new Map(workers.flatMap(worker => worker.availableChannels)
          .map(channel => [channel.guildId, { id: channel.guildId, name: channel.guildName }])).values()]
          .sort((a, b) => a.name.localeCompare(b.name));
        return json(res, 200, { defaultWorkerId: broker.defaultWorkerId, workers, guilds });
      }
      const workerChannelsMatch = !scopedWorker && /^\/api\/workers\/([A-Za-z0-9_-]{1,32})\/channels$/.exec(url.pathname);
      if (workerChannelsMatch) {
        if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });
        const workerId = workerChannelsMatch[1];
        let worker = broker.getWorker(workerId);
        if (!worker && ![broker.defaultWorkerId, ...configuredWorkerIds].includes(workerId) && !broker.knownWorkerIds?.has(workerId)) return json(res, 404, { error: 'Unknown worker.' });
        let cached = true;
        if (worker && url.searchParams.get('refresh') === 'true') {
          const result = await broker.request('list-channels', { refresh: true }, workerId);
          if (!result?.ok) return json(res, 502, { error: result?.message || 'Channel discovery failed.' });
          worker = { ...worker, availableChannels: result.availableChannels || [], channelsTruncated: result.channelsTruncated === true || result.availableChannels?.length > 5000 };
          cached = result.cached === true;
        }
        return json(res, 200, { online: !!worker, availableChannels: availableFor(worker),
          channelsTruncated: worker?.channelsTruncated === true, cached });
      }
      const channelMatch = /^\/api\/guilds\/(\d{17,20})\/channels$/.exec(url.pathname);
      if (!scopedWorker && req.method === 'GET' && channelMatch) {
        const guild = client.guilds.cache.get(channelMatch[1]) || await client.guilds.fetch(channelMatch[1]).catch(() => null);
        if (!guild) return json(res, 404, { error: 'Server unavailable to the CS bot; use manual IDs.' });
        const channels = await guild.channels.fetch();
        const local = [...channels.values()]
          .filter(channel => channel && (channel.type === 2 || channel.type === 13))
          .map(channel => ({ guildId: guild.id, guildName: guild.name,
            id: channel.id, name: channel.name, type: channel.type, external: false }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return json(res, 200, { channels: local });
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
        if (operation === 'toggle-music-mode' && ((scopedWorker || body.enabled !== undefined) && typeof body.enabled !== 'boolean')) return json(res, 400, { error: 'Enabled must be a boolean.' });
        if (operation === 'set-queue-gap' && (!Number.isInteger(body.seconds) || body.seconds < 0 || body.seconds > 300)) return json(res, 400, { error: 'Between-video interval must be an integer from 0 to 300 seconds.' });
        if (operation === 'set-queue-limit' && (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > 1000)) return json(res, 400, { error: 'Queue limit must be an integer from 1 to 1000.' });
        if (['set-content-nickname', 'set-content-preview'].includes(operation) && typeof body.enabled !== 'boolean') {
          return json(res, 400, { error: 'Enabled must be a boolean.' });
        }
        if (operation === 'set-content-preview' && body.snapshotEnabled !== undefined && typeof body.snapshotEnabled !== 'boolean') return json(res, 400, { error: 'Snapshot enabled must be a boolean.' });
        if (operation === 'set-content-preview' && body.enabled && body.snapshotEnabled) return json(res, 400, { error: 'Preview modes are mutually exclusive.' });
        const payload = { requestedBy: scopedWorker ? 'public-link' : 'dashboard' };
        if (operation === 'toggle-music-mode' && body.enabled !== undefined) payload.enabled = body.enabled;
        if (operation === 'set-queue-limit') payload.limit = body.limit;
        if (operation === 'set-queue-gap') payload.seconds = body.seconds;
        if (['set-content-nickname', 'set-content-preview'].includes(operation)) payload.enabled = body.enabled;
        if (operation === 'set-content-preview' && body.snapshotEnabled !== undefined) payload.snapshotEnabled = body.snapshotEnabled;
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
          if (!Array.isArray(body.ids) || body.ids.length > MAX_REORDER_ITEMS ||
              body.ids.some(id => typeof id !== 'string' || id.length > 64)) {
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
          status: scopedWorker ? scopedFor(scopedWorker, scopedMatch[1], result.status) : publicStatus(result.status),
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
    else if (filename === 'index.html') {
      res.end(brandDashboardHtml(data.toString('utf8'), publicId));
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
    server, schedules,
    listen() { schedules.start(); server.listen(port, host, () => log(`[stream-dashboard] listening on http://${host}:${server.address().port}`)); },
    close() {
      schedules.dispose(); thumbnailAbort.abort(); thumbnailCache.clear();
      for (const job of thumbnailPending.splice(0)) { thumbnailFlights.delete(job.key); job.resolve(null); }
      return new Promise(resolve => server.close(resolve));
    }
  };
}

module.exports = { createStreamDashboard, parseExternalChannels, publicStatus, scopedStatus, sameToken };
