'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createStreamDashboard, parseExternalChannels, publicStatus, scopedStatus } = require('../src/streamDashboard');
const { normalizeResults } = require('../src/youtubeSearch');

const guildId = '111111111111111111';
const channelId = '222222222222222222';
const userId = '333333333333333333';
const externalGuildId = '555555555555555555';
const externalChannelId = '666666666666666666';

test('external channel CSV accepts valid pairs and ignores duplicates or malformed entries', () => {
  assert.deepEqual(parseExternalChannels(` ${externalGuildId}:${externalChannelId},bad,${externalGuildId}:${externalChannelId} `),
    [{ guildId: externalGuildId, id: externalChannelId }]);
});

test('dashboard strips resolved media URLs from its public status', () => {
  const status = publicStatus({ guildId, channelId, streamUrl: 'https://secret.example/?ApiKey=private',
    current: { id: 'a', title: 'A', thumbnail: 'https://images.example/a.jpg', durationSec: 100 },
    queue: [{ id: 'b', title: 'B' }] });
  assert.equal(status.current.title, 'A');
  assert.equal(status.current.thumbnail, 'https://images.example/a.jpg');
  assert.equal(status.queue[0].id, 'b');
  assert(!JSON.stringify(status).includes('ApiKey'));
});

test('public worker status omits channel IDs and credential-bearing thumbnails', () => {
  const status = scopedStatus({ guildId, channelId,
    current: { id: 'one', title: 'Movie', thumbnail: 'https://jelly.example/Images/Primary?ApiKey=secret' },
    queue: [{ id: 'two', title: 'Next', thumbnail: 'https://i.ytimg.com/vi/example/default.jpg' }] });
  assert.equal(status.inVoiceChannel, true);
  assert.equal(status.guildId, undefined);
  assert.equal(status.channelId, undefined);
  assert.equal(status.current.thumbnail, null);
  assert.equal(status.queue[0].thumbnail, 'https://i.ytimg.com/vi/example/default.jpg');
});

test('YouTube search results expose only playable URLs and safe display metadata', () => {
  const results = normalizeResults([
    { id: 'abcdefghijk', title: 'A song', description: 'One\n two', duration: 91 },
    { id: 'invalid', title: 'Bad' },
    { id: 'lmnopqrstuv', availability: 'private', title: 'Private' }
  ]);
  assert.deepEqual(results, [{ id: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk',
    title: 'A song', description: 'One two', durationSec: 91,
    thumbnail: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg' }]);
});

test('YouTube search uses extractor thumbnails without accepting external image hosts', () => {
  const results = normalizeResults([
    { id: 'abcdefghijk', thumbnails: [{ url: 'https://i.ytimg.com/vi/abcdefghijk/hq720.jpg?token=abc', width: 480 }] },
    { id: 'lmnopqrstuv', thumbnail: 'https://example.com/vi/lmnopqrstuv/image.jpg' }
  ]);
  assert.equal(results[0].thumbnail, 'https://i.ytimg.com/vi/abcdefghijk/hq720.jpg?token=abc');
  assert.equal(results[1].thumbnail, 'https://i.ytimg.com/vi/lmnopqrstuv/hqdefault.jpg');
});

test('dashboard authenticates reads and commands, routes moves/reorders, and falls back to nickname', async t => {
  const staticDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-dashboard-test-'));
  await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html><head></head><body>Player</body>');
  t.after(() => fs.rm(staticDir, { recursive: true, force: true }));
  const calls = []; const nicknames = []; const searches = [];
  const member = { nickname: null, manageable: true, setNickname: async name => nicknames.push(name) };
  const hiddenChannelId = '444444444444444444';
  const guild = { id: guildId, name: 'Test server', members: { cache: new Map(), fetch: async () => member },
    channels: { fetch: async () => new Map([[channelId, { id: channelId, name: 'Movies', type: 2 }],
      [hiddenChannelId, { id: hiddenChannelId, name: 'Hidden', type: 2 }]]) } };
  const user = { id: userId, globalName: 'Streamer', username: 'streamer', displayAvatarURL: () => 'https://cdn.discordapp.com/a.png' };
  // The CS app bot is not in the external server; the primary stream worker is.
  const guildCache = new Map([[guildId, guild]]);
  const client = { guilds: { cache: guildCache, fetch: async id => guildCache.get(id) || null },
    users: { cache: new Map([[userId, user]]), fetch: async () => user } };
  let online = true;
  const activeWorker = { id: 'one', userId, connectedAt: 1, queueLimit: 250,
    availableChannels: [{ guildId: externalGuildId, guildName: 'Friends server',
      id: externalChannelId, name: 'Watch party', type: 2 }],
    status: { guildId, channelId, alive: true, inChannel: true, streamUrl: 'https://secret/?ApiKey=private',
      queue: [{ id: 'q1', title: 'Next' }], current: { id: 'now', title: 'Playing' } } };
  const broker = { defaultWorkerId: 'one', listWorkers: () => online ? [activeWorker] : [],
  getWorkerByAccessCode: code => online && code === 'abcdef' ? activeWorker : null,
  getWorker: id => online && id === 'one' ? activeWorker : null, request: async (operation, payload, workerId) => {
    calls.push({ operation, payload, workerId });
    if (operation === 'list-channels') return { ok: true, availableChannels: activeWorker.availableChannels, cached: false };
    if (operation === 'set-global-name') return { ok: false, message: 'CAPTCHA_SOLVER_NOT_IMPLEMENTED' };
    return { ok: true, message: 'Done.', status: null };
  } };
  const dashboard = createStreamDashboard({ broker, client, password: 'CaseSensitivePassword',
    configuredWorkerIds: ['one','two'], channelIds: [channelId],
    host: '127.0.0.1', port: 0, staticDir, log: () => {},
    searchYoutube: async (query, { page }) => { searches.push({ query, page }); return [{ title: 'Found', url: 'https://www.youtube.com/watch?v=abcdefghijk' }]; } });
  dashboard.listen(); await once(dashboard.server, 'listening');
  t.after(() => dashboard.close());
  const base = `http://127.0.0.1:${dashboard.server.address().port}`;
  const request = (route, body, password = 'CaseSensitivePassword') => fetch(`${base}${route}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${password}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body && JSON.stringify(body)
  });
  assert.equal((await fetch(`${base}/api/auth-question`)).status, 401);
  assert.equal((await request('/api/state', null, 'casesensitivepassword')).status, 401);
  assert.equal((await request('/api/state', null, 'wrong')).status,401);
  assert.equal((await request('/api/workers/one/search?q=music', null, 'wrong')).status, 401);
  assert.equal((await request('/api/workers/one/search?q=x')).status, 400);
  assert.equal((await request('/api/workers/one/search?q=music&page=21')).status, 400);
  assert.equal((await request('/api/workers/two/search?q=music')).status, 404);
  assert.deepEqual((await (await request('/api/workers/one/search?q=music')).json()).results.map(item => item.title), ['Found']);
  assert.deepEqual((await (await request('/api/workers/one/search?q=music&page=2')).json()).results.map(item => item.title), ['Found']);
  const fetchUser = client.users.fetch;
  const fetchMember = guild.members.fetch;
  client.users.cache.clear();
  activeWorker.profile = { displayName: 'Streamer', globalName: 'Streamer',
    avatarUrl: 'https://cdn.discordapp.com/avatars/test.png' };
  let profileRestCalls = 0;
  client.users.fetch = guild.members.fetch = async () => { profileRestCalls++; throw new Error('Discord REST unavailable'); };
  const state = await (await request(`/api/state?guildId=${guildId}`)).json();
  assert.equal(profileRestCalls, 0, 'dashboard polling must not wait for Discord REST profile lookups');
  assert.equal(state.workers[0].profile.avatarUrl, activeWorker.profile.avatarUrl);
  client.users.cache.set(userId, user);
  client.users.fetch = fetchUser;
  guild.members.fetch = fetchMember;
  assert.equal(state.workers.length,2);
  assert.equal(state.workers[1].online,false);
  assert.equal(state.workers[0].profile.displayName,'Streamer');
  assert.deepEqual(state.workers[0].availableChannels, activeWorker.availableChannels);
  assert.deepEqual(state.workers[1].availableChannels, []);
  assert.deepEqual(state.guilds, [{ id: externalGuildId, name: 'Friends server' }]);
  const discovered = await (await request('/api/workers/one/channels?refresh=true')).json();
  assert.deepEqual(discovered.availableChannels, activeWorker.availableChannels);
  assert.deepEqual(calls.pop(), { operation: 'list-channels', payload: { refresh: true }, workerId: 'one' });
  assert.equal((await request('/api/workers/one/channels', null, 'wrong')).status, 401);
  assert.deepEqual((await (await request('/api/workers/two/channels')).json()).availableChannels, []);
  assert.equal((await request('/api/workers/unknown/channels')).status, 404);
  assert(!JSON.stringify(state).includes('ApiKey'));
  const channels = await (await request(`/api/guilds/${guildId}/channels`)).json();
  assert.deepEqual(channels.channels.map(channel=>channel.name),['Hidden', 'Movies']);
  const move = await (await request('/api/workers/one/actions', { operation:'move', guildId, channelId })).json();
  assert.equal(move.ok,true);
  const externalMove = await (await request('/api/workers/one/actions', { operation:'move', guildId: externalGuildId,
    channelId: externalChannelId })).json();
  assert.equal(externalMove.ok,true);
  assert.equal(calls.at(-1).payload.guildId, externalGuildId);
  const reorder = await (await request('/api/workers/one/actions', { operation:'reorder', ids:['q1'] })).json();
  assert.equal(reorder.ok,true);
  const seek = await (await request('/api/workers/one/actions', { operation:'seek', positionSec:1234 })).json();
  assert.equal(seek.ok,true);
  assert.equal(calls.at(-1).payload.positionSec,1234);
  const queueId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const remove = await (await request('/api/workers/one/actions', { operation:'remove-queued', queueId })).json();
  assert.equal(remove.ok,true);
  assert.deepEqual(calls.slice(0,5).map(call=>call.operation),['move','move','reorder','seek','remove-queued']);
  assert.equal(calls.find(call => call.operation === 'remove-queued').payload.queueId,queueId);
  const clear = await (await request('/api/workers/one/actions', { operation:'clear-queue' })).json();
  assert.equal(clear.ok,true);
  assert.equal(calls.at(-1).operation,'clear-queue');
  const largeOrder = Array.from({ length: 1000 }, (_, index) => String(index).padStart(36, '0'));
  assert.equal((await request('/api/workers/one/actions', { operation: 'reorder', ids: largeOrder })).status, 200);
  assert.equal(calls.at(-1).payload.ids.length, 1000);
  assert.equal((await request('/api/workers/one/actions', { operation: 'reorder', ids: [...largeOrder, 'extra'] })).status, 400);
  assert.equal((await request('/api/workers/one/actions', { operation:'remove-queued', queueId:'bad' })).status,400);
  assert.equal((await request('/api/workers/one/actions', { operation: 'set-video-quality', height: 720, bitrateKbps: 8000 })).status, 200);
  assert.deepEqual(calls.at(-1), { operation: 'set-video-quality', payload: { requestedBy: 'dashboard', height: 720, bitrateKbps: 8000 }, workerId: 'one' });
  for (const height of [null, '720', -1, 4321]) assert.equal((await request('/api/workers/one/actions', { operation: 'set-video-quality', height, bitrateKbps: 4000 })).status, 400);
  for (const seconds of [-1, 301, 1.5, '15', null]) assert.equal((await request('/api/workers/one/actions', { operation: 'set-queue-gap', seconds })).status, 400);
  assert.equal((await request('/api/workers/one/actions', { operation: 'set-queue-gap', seconds: 0 })).status, 200);
  assert.deepEqual(calls.at(-1), { operation: 'set-queue-gap', payload: { requestedBy: 'dashboard', seconds: 0 }, workerId: 'one' });
  for (const limit of [0, 1001, 1.5, '100', null]) {
    assert.equal((await request('/api/workers/one/actions', { operation: 'set-queue-limit', limit })).status, 400);
  }
  assert.equal((await request('/api/workers/one/actions', { operation: 'set-queue-limit', limit: 250 })).status, 200);
  assert.deepEqual(calls.at(-1), { operation: 'set-queue-limit', payload: { requestedBy: 'dashboard', limit: 250 }, workerId: 'one' });
  const name = await (await request('/api/workers/one/actions', { operation:'set-name', guildId, name:'Movie Night' })).json();
  assert.equal(name.scope,'guild');
  assert.deepEqual(nicknames,['Movie Night']);
  assert.equal((await request('/api/workers/one/actions', { operation:'stop' }, 'wrong')).status,401);
  const publicFetch = (route, body) => fetch(`${base}${route}`, { method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  const publicPage = await publicFetch('/one');
  assert.equal(publicPage.status, 200);
  assert.equal(publicPage.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await publicPage.text(), /name="stream-public-id" content="one"/);
  assert.equal((await publicFetch('/abcdef')).status, 404);
  assert.equal((await publicFetch('/xxxxxx')).status, 404);
  const scoped = await (await publicFetch('/api/public/one/state')).json();
  assert.deepEqual(scoped.worker.status.queue.map(item => item.title), ['Next']);
  assert.equal(scoped.worker.status.guildId, undefined);
  assert.equal(scoped.worker.status.channelId, undefined);
  assert.equal(scoped.guilds, undefined);
  assert.equal(scoped.worker.availableChannels, undefined);
  assert.equal(scoped.worker.queueLimit, undefined);
  assert.equal(scoped.worker.queueGapSeconds, undefined);
  assert.equal(scoped.worker.videoQuality, undefined);
  assert.equal((await publicFetch('/api/public/one/actions', { operation: 'set-video-quality', height: 720, bitrateKbps: 4000 })).status, 403);
  assert.equal((await publicFetch('/api/public/one/actions', { operation: 'set-queue-gap', seconds: 15 })).status, 403);
  assert.equal((await publicFetch('/api/public/one/actions', { operation: 'set-queue-limit', limit: 250 })).status, 403);
  assert.equal((await publicFetch('/api/public/one/search?q=x')).status, 400);
  assert.deepEqual((await (await publicFetch('/api/public/one/search?q=music')).json()).results.map(item => item.title), ['Found']);
  assert.deepEqual(searches, [{ query: 'music', page: 1 }, { query: 'music', page: 2 }, { query: 'music', page: 1 }]);
  assert.equal((await publicFetch('/api/public/two/search?q=music')).status, 404);
  const scopedPlay = await (await publicFetch('/api/public/one/actions', { operation: 'play',
    source: 'https://youtube.com/watch?v=test', guildId: externalGuildId, channelId: externalChannelId })).json();
  assert.equal(scopedPlay.ok, true);
  assert.equal(scopedPlay.queueLimit, undefined);
  assert.equal(calls.at(-1).workerId, 'one');
  assert.equal(calls.at(-1).payload.guildId, guildId);
  assert.equal(calls.at(-1).payload.channelId, channelId);
  for (const enabled of [true, false]) {
    assert.equal((await publicFetch('/api/public/one/actions', { operation: 'toggle-music-mode', enabled, workerId: 'two' })).status, 200);
    assert.equal(calls.at(-1).workerId, 'one');
    assert.equal(calls.at(-1).operation, 'toggle-music-mode');
    assert.equal(calls.at(-1).payload.enabled, enabled);
    assert.equal(calls.at(-1).payload.requestedBy, 'public-link');
  }
  for (const enabled of [undefined, null, 'true', 1]) {
    assert.equal((await publicFetch('/api/public/one/actions', { operation: 'toggle-music-mode', enabled })).status, 400);
  }
  for (const operation of ['join', 'toggle-overlay', 'set-content-preview', 'set-content-nickname']) {
    assert.equal((await publicFetch('/api/public/one/actions', { operation, enabled: true })).status, 403);
  }
  const scopedClear = await (await publicFetch('/api/public/one/actions', { operation: 'clear-queue' })).json();
  assert.equal(scopedClear.ok, true);
  assert.equal(calls.at(-1).workerId, 'one');
  assert.equal(calls.at(-1).operation, 'clear-queue');
  assert.equal((await publicFetch('/api/public/one/actions', { operation: 'reorder', ids: largeOrder })).status, 200);
  assert.equal((await publicFetch('/api/public/one/actions', { operation: 'move',
    guildId: externalGuildId, channelId: externalChannelId })).status, 403);
  assert.equal((await publicFetch('/api/public/one/actions', { operation: 'set-name', name: 'Hijack' })).status, 403);
  assert.equal((await publicFetch('/api/public/one/actions', { operation: 'stop' })).status, 403);
  assert.equal((await publicFetch('/api/public/two/state')).status, 404);
  assert.equal((await publicFetch(`/api/guilds/${guildId}/channels`)).status, 401);
  assert.equal((await publicFetch('/api/state')).status, 401);
  assert.equal((await publicFetch('/api/workers/one/channels')).status, 401);
  assert.equal((await publicFetch('/api/public/one/channels')).status, 401);
  assert.equal((await publicFetch('/api/public/one/actions', { operation: 'list-channels' })).status, 403);
  activeWorker.status = { ...activeWorker.status, alive: false };
  assert.equal((await publicFetch('/one')).status, 404);
  assert.equal((await publicFetch('/api/public/one/state')).status, 404);
  assert.equal((await publicFetch('/api/public/one/search?q=music')).status, 404);
  assert.equal((await publicFetch('/api/public/one/actions', { operation: 'pause' })).status, 404);
  assert.equal((await publicFetch('/api/public/one/actions', { operation: 'clear-queue' })).status, 404);
  assert.equal((await publicFetch('/api/public/one/actions', { operation: 'toggle-music-mode', enabled: true })).status, 404);
  activeWorker.status = { ...activeWorker.status, alive: true, channelId: null };
  assert.equal((await publicFetch('/one')).status, 404);
  activeWorker.status = { ...activeWorker.status, channelId, inChannel: false };
  assert.equal((await publicFetch('/one')).status, 404);
  online = false;
  assert.equal((await publicFetch('/one')).status, 404);
  online = true;
  activeWorker.status = { ...activeWorker.status, alive: true, inChannel: true, guildId, channelId };
  const randomDashboard = createStreamDashboard({ broker, client, password: 'CaseSensitivePassword',
    randomCodes: true, host: '127.0.0.1', port: 0, staticDir, log: () => {} });
  randomDashboard.listen(); await once(randomDashboard.server, 'listening');
  t.after(() => randomDashboard.close());
  const randomBase = `http://127.0.0.1:${randomDashboard.server.address().port}`;
  assert.equal((await fetch(`${randomBase}/abcdef`)).status, 200);
  assert.equal((await fetch(`${randomBase}/one`)).status, 404);
  assert.equal((await fetch(`${randomBase}/api/public/abcdef/state`)).status, 200);
  assert.equal((await fetch(`${randomBase}/api/public/one/state`)).status, 404);
});

test('admin schedules configured offline workers; public and unauthenticated scheduling denied', async () => {
  const broker = { defaultWorkerId: 'primary', getWorker: () => null, listWorkers: () => [] };
  const client = { users: { cache: new Map() }, guilds: { cache: new Map() } };
  const dashboard = createStreamDashboard({ broker, client, password: 'secret', host: '127.0.0.1', port: 0, configuredWorkerIds: ['offline'], log: () => {} });
  dashboard.listen(); await once(dashboard.server, 'listening');
  const base = `http://127.0.0.1:${dashboard.server.address().port}`;
  const headers = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(`${base}/api/workers/offline/schedules`)).status, 401);
    assert.equal((await fetch(`${base}/api/public/offline/schedules`)).status, 401);
    const response = await fetch(`${base}/api/workers/offline/schedules`, { method: 'POST', headers, body: JSON.stringify({ sources: ['sports'], guildId, channelId, startAt: new Date(Date.now() + 60000).toISOString() }) });
    assert.equal(response.status, 201); const { schedule } = await response.json();
    const listed = await (await fetch(`${base}/api/workers/offline/schedules`, { headers })).json(); assert.equal(listed.schedules[0].id, schedule.id);
    assert.equal((await fetch(`${base}/api/workers/unknown/schedules`, { headers })).status, 404);
    const editBody = { sources: ['news'], guildId, channelId, startAt: new Date(Date.now() + 120000).toISOString(), nickname: 'Movie night' };
    const edited = await fetch(`${base}/api/workers/offline/schedules/${schedule.id}`, { method: 'PUT', headers, body: JSON.stringify(editBody) });
    assert.equal(edited.status, 200);
    const updated = (await edited.json()).schedule;
    assert.equal(updated.id, schedule.id); assert.equal(updated.nickname, 'Movie night'); assert.deepEqual(updated.sources, ['news']);
    assert.equal((await fetch(`${base}/api/workers/offline/schedules/${schedule.id}`, { method: 'PUT', body: JSON.stringify(editBody) })).status, 401);
    assert.equal((await fetch(`${base}/api/public/offline/schedules/${schedule.id}`, { method: 'PUT', body: JSON.stringify(editBody) })).status, 401);
    assert.equal((await fetch(`${base}/api/workers/offline/schedules/${schedule.id}`, { method: 'PUT', headers, body: JSON.stringify({ ...editBody, nickname: {} }) })).status, 400);
    const cancelled = await fetch(`${base}/api/workers/offline/schedules/${schedule.id}`, { method: 'DELETE', headers }); assert.equal(cancelled.status, 200); assert.equal((await cancelled.json()).schedule.status, 'cancelled');
    assert.equal((await fetch(`${base}/api/workers/offline/schedules/${schedule.id}`, { method: 'PUT', headers, body: JSON.stringify(editBody) })).status, 409);
    assert.equal((await fetch(`${base}/api/workers/offline/schedules/${schedule.id}`, { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(`${base}/api/public/offline/schedules/${schedule.id}`, { method: 'DELETE' })).status, 401);
    const removed = await fetch(`${base}/api/workers/offline/schedules/${schedule.id}`, { method: 'DELETE', headers });
    assert.equal(removed.status, 200); assert.equal((await removed.json()).deleted, true);
    assert.equal(dashboard.schedules.list('offline').length, 0);
    const running = { ...schedule, id: require('node:crypto').randomUUID(), status: 'running' };
    dashboard.schedules.jobs.push(running);
    assert.equal((await fetch(`${base}/api/workers/offline/schedules/${running.id}`, { method: 'DELETE', headers })).status, 409);
    const failed = { ...schedule, id: require('node:crypto').randomUUID(), status: 'failed' };
    dashboard.schedules.jobs.push(failed);
    assert.equal((await (await fetch(`${base}/api/workers/offline/schedules/${failed.id}`, { method: 'DELETE', headers })).json()).deleted, true);

  } finally { await dashboard.close(); }
});

test('live ShareTV programme refresh reaches public and admin status without restarting playback', async t => {
  const { StreamManager } = require('../src/streambot/streamManager');
  const manager = new StreamManager({}, null, { shareTvBase: 'https://tv.example' });
  const piece = { queueId: 'live', sourceKind: 'sharetv', shareTvChannel: true,
    title: 'The Big Pro Football Show', contentTitle: 'The Big Pro Football Show',
    isLive: true, videoUrl: 'https://private.example/stream?ApiKey=secret' };
  const queued = { queueId: 'next', sourceKind: 'youtube', title: 'Queued video', contentTitle: 'Other metadata' };
  const pipeline = { enqueue: [piece, queued] };
  manager.voiceLink = { guildId, channelId, pipeline, joinedAt: Date.now() };
  manager.session = piece;
  manager.positionOf = () => 42;
  const worker = { id: 'one', connectedAt: 1, get status() { return manager.status(); } };
  const broker = { defaultWorkerId: 'one', listWorkers: () => [worker], getWorker: () => worker };
  const dashboard = createStreamDashboard({ broker, client: {}, password: 'password',
    host: '127.0.0.1', port: 0, log: () => {} });
  dashboard.listen(); await once(dashboard.server, 'listening');
  t.after(() => dashboard.close());
  const base = `http://127.0.0.1:${dashboard.server.address().port}`;
  const publicState = async () => (await (await fetch(`${base}/api/public/one/state`)).json()).worker.status;
  assert.equal((await publicState()).current.title, 'The Big Pro Football Show');
  await manager.shareTvNicknameRefresh.onProgramme(piece, 'NBA Basketball', { title: 'NBA Basketball' });
  // The existing metadata hook updates the same session and transport.
  assert.equal(manager.session, piece);
  assert.equal(manager.voiceLink.pipeline, pipeline);
  assert.equal(piece.title, 'The Big Pro Football Show');
  const status = await publicState();
  assert.equal(status.current.title, 'NBA Basketball');
  assert.equal(status.title, 'NBA Basketball');
  assert.equal(status.queue[0].title, 'Queued video');
  assert.equal(status.positionSec, 42);
  assert(!JSON.stringify(status).includes('private.example'));
  assert(!JSON.stringify(status).includes('ApiKey'));
  const admin = await (await fetch(`${base}/api/state`, { headers: { Authorization: 'Bearer password' } })).json();
  assert.equal(admin.workers[0].status.current.title, 'NBA Basketball');
  assert.equal(admin.workers[0].status.title, 'NBA Basketball');
  manager.voiceLink.paused = true;
  manager.voiceLink.pausedSession = piece;
  manager.session = null;
  assert.equal((await publicState()).current.title, 'NBA Basketball');
  piece.contentTitle = null;
  assert.equal(manager.status().current.title, 'The Big Pro Football Show');
  piece.contentTitle = '';
  assert.equal(manager.status().title, 'The Big Pro Football Show');
  piece.contentTitle = 'Unrelated metadata'; piece.shareTvChannel = false;
  assert.equal(manager.status().current.title, 'The Big Pro Football Show');
  piece.shareTvChannel = true; piece.isFiller = true;
  assert.equal(manager.status().current.title, 'The Big Pro Football Show');
});

test('public artwork resolves only active scoped current and queued items and conceals upstream credentials', async t => {
  const sharp = require('sharp');
  const image = await sharp({ create: { width: 20, height: 40, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const worker = { id: 'one', connectedAt: 1, status: { alive: true, inChannel: true, guildId, channelId,
    current: { id: 'current', sourceKind: 'jellyfin', title: '<b>Movie</b> https://secret.example/key',
      presenceTitle: '<b>Movie (2026)</b>', presenceDetails: 'A '.repeat(1000),
      thumbnail: 'http://private.example/poster?ApiKey=secret' },
    queue: [{ id: 'queued', sourceKind: 'sharetv', title: 'Next', programmeDescription: 'An <i>episode</i>',
      thumbnail: 'http://private.example/next?signature=secret2' }] } };
  const other = { ...worker, id: 'two' };
  let calls = 0;
  const broker = { getWorker: id => ({ one: worker, two: other })[id], request: async () => ({ ok: true, status: worker.status }) };
  const dashboard = createStreamDashboard({ broker, client: {}, password: 'password', host: '127.0.0.1', port: 0,
    log: () => {}, fetchThumbnail: async () => { calls++; return image; } });
  dashboard.listen(); await once(dashboard.server, 'listening'); t.after(() => dashboard.close());
  const base = `http://127.0.0.1:${dashboard.server.address().port}`;
  const state = async () => (await (await fetch(`${base}/api/public/one/state`)).json()).worker.status;
  const status = await state();
  assert.equal(status.current.title, 'Movie');
  assert.equal(status.current.presenceTitle, 'Movie (2026)');
  assert.equal(status.current.presenceDetails.length, 1000);
  assert.equal(status.queue[0].programmeDescription, 'An episode');
  assert(!/secret|private\.example|ApiKey|signature|guildId|channelId/.test(JSON.stringify(status)));
  assert.equal(calls, 0, 'state polling does not fetch artwork');
  const currentUrl = status.current.thumbnail, queuedUrl = status.queue[0].thumbnail;
  assert.equal((await fetch(base + currentUrl)).status, 200);
  assert.equal((await fetch(base + queuedUrl)).status, 200);
  assert.equal((await fetch(base + currentUrl)).status, 200);
  assert.equal(calls, 2, 'bounded cache reuses converted images');
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 3600000;
    assert.equal((await fetch(base + currentUrl)).status, 200);
    assert.equal(calls, 2, 'current poster remains available beyond upstream signed URL lifetime');
  } finally { Date.now = originalNow; }
  assert.equal((await fetch(base + currentUrl.replace('/one/', '/two/'))).status, 404);
  assert.equal((await fetch(base + currentUrl + '?url=http://arbitrary.example')).status, 404);
  const action = await (await fetch(`${base}/api/public/one/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'pause' }) })).json();
  assert.equal(action.status.queue[0].thumbnail, queuedUrl);
  worker.status.queue = [];
  assert.equal((await fetch(base + queuedUrl)).status, 404);
  worker.status.current.thumbnail += '&revision=2';
  assert.notEqual((await state()).current.thumbnail, currentUrl);
  assert.equal((await fetch(base + currentUrl)).status, 404);
  const refreshedUrl = (await state()).current.thumbnail;
  worker.status.inChannel = false;
  assert.equal((await fetch(base + refreshedUrl)).status, 404);
});

test('public artwork bounds concurrent fetches, deduplicates flights, rejects oversized outputs and caps cache', async t => {
  const worker = { id: 'one', connectedAt: 1, status: { alive: true, inChannel: true, guildId, channelId,
    queue: Array.from({ length: 35 }, (_, i) => ({ id: String(i), thumbnail: `http://private.example/${i}?token=secret` })) } };
  let calls = 0, blocked = true;
  const pending = [];
  const broker = { getWorker: id => id === 'one' ? worker : null };
  const dashboard = createStreamDashboard({ broker, client: {}, password: 'password', host: '127.0.0.1', port: 0,
    log: () => {}, fetchThumbnail: async () => { calls++; if (blocked) await new Promise(resolve => pending.push(resolve)); return Buffer.alloc(256 * 1024 + 1); } });
  dashboard.listen(); await once(dashboard.server, 'listening'); t.after(() => dashboard.close());
  const base = `http://127.0.0.1:${dashboard.server.address().port}`;
  const status = (await (await fetch(`${base}/api/public/one/state`)).json()).worker.status;
  const get = i => fetch(base + status.queue[i].thumbnail);
  const flights = [get(0), get(0), get(1), get(2)];
  for (let i = 0; i < 100 && pending.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(pending.length, 3); assert.equal(calls, 3);
  const queuedRequest = get(3);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls, 3, 'excess parallel requests wait for capacity');
  blocked = false; pending.forEach(resolve => resolve());
  assert((await Promise.all(flights)).every(response => response.status === 404));
  assert.equal((await queuedRequest).status, 404);
  await get(0); assert.equal(calls, 4, 'invalid images are negatively cached');
  for (let i = 3; i < 35; i++) assert.equal((await get(i)).status, 404);
  const before = calls; await get(0);
  assert.equal(calls, before + 1, 'oldest entry is evicted after the 32-entry cap');
});


test('public artwork queues visible bursts with at most three image fetches active', async t => {
  const worker = { id: 'one', connectedAt: 1, status: { alive: true, inChannel: true, guildId, channelId,
    queue: Array.from({ length: 12 }, (_, i) => ({ id: String(i), thumbnail: `http://private.example/${i}` })) } };
  let active = 0, maximum = 0, calls = 0;
  const dashboard = createStreamDashboard({ broker: { getWorker: () => worker }, client: {}, password: 'password',
    host: '127.0.0.1', port: 0, log: () => {}, fetchThumbnail: async () => {
      calls++; active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 15)); active--;
      return Buffer.from('jpeg');
    } });
  dashboard.listen(); await once(dashboard.server, 'listening'); t.after(() => dashboard.close());
  const base = `http://127.0.0.1:${dashboard.server.address().port}`;
  const status = (await (await fetch(`${base}/api/public/one/state`)).json()).worker.status;
  const responses = await Promise.all(status.queue.map(item => fetch(base + item.thumbnail)));
  assert(responses.every(response => response.status === 200));
  assert.equal(maximum, 3); assert.equal(calls, 12);
});


test('public artwork retries a transient failure after its five second negative cache expires', async t => {
  const worker = { id: 'one', connectedAt: 1, status: { alive: true, inChannel: true, guildId, channelId,
    current: { id: 'current', thumbnail: 'http://private.example/poster?ApiKey=secret' } } };
  let calls = 0;
  const dashboard = createStreamDashboard({ broker: { getWorker: () => worker }, client: {}, password: 'password',
    host: '127.0.0.1', port: 0, log: () => {}, fetchThumbnail: async () => ++calls === 1 ? null : Buffer.from('jpeg') });
  dashboard.listen(); await once(dashboard.server, 'listening'); t.after(() => dashboard.close());
  const base = `http://127.0.0.1:${dashboard.server.address().port}`;
  const status = (await (await fetch(`${base}/api/public/one/state`)).json()).worker.status;
  const get = () => fetch(base + status.current.thumbnail);
  assert.equal((await get()).status, 404);
  assert.equal((await get()).status, 404); assert.equal(calls, 1);
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 6000;
    assert.equal((await get()).status, 200); assert.equal(calls, 2);
  } finally { Date.now = originalNow; }
});


test('public gap transition uses real queue artwork and excludes filler snapshot secrets', () => {
  const input = { current: { id: 'gap', title: 'buffer', isFiller: true, durationSec: 15 },
    transition: { kind: 'up-next', upNext: { thumbnail: 'https://secret.example/?token=secret' } },
    positionSec: 3, queue: [{ id: 'filler', isFiller: true }, { id: 'next', title: 'Next episode',
      presenceTitle: 'Blue skies', presenceDetails: 'S01E02 · The garden',
      thumbnail: 'https://private.example/image?ApiKey=private' }] };
  const scoped = scopedStatus(input, item => item.thumbnail ? `/safe/${item.id}.jpg` : null);
  assert.deepEqual(scoped.transition, { kind: 'up-next', remainingSec: 12 });
  assert.equal(scoped.queue[1].thumbnail, '/safe/next.jpg');
  assert.equal(scoped.queue[1].presenceDetails, 'S01E02 · The garden');
  assert(!JSON.stringify(scoped).includes('private'));
  assert(!JSON.stringify(scoped).includes('secret'));
  assert.equal(scopedStatus({ ...input, transition: null }).transition, null);
  assert.equal(scopedStatus({ ...input, queue: [] }).transition, null);
  assert.equal(scopedStatus({ ...input, musicMode: true }).transition, null);
  assert.equal(scopedStatus({ ...input, current: { ...input.current, isFiller: false } }).transition, null);
  assert.equal(scopedStatus({ ...input, positionSec: 30 }).transition.remainingSec, 0);
});

test('public poster response rejects a programme change while its image is in flight', async t => {
  const worker = { id: 'one', connectedAt: 1, status: { alive: true, inChannel: true, guildId, channelId,
    current: { id: 'current', sourceKind: 'sharetv', title: 'First programme', thumbnail: 'http://private.example/poster' } } };
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const dashboard = createStreamDashboard({ broker: { getWorker: () => worker }, client: {}, password: 'password',
    host: '127.0.0.1', port: 0, log: () => {}, fetchThumbnail: () => new Promise(resolve => { release = resolve; entered(); }) });
  dashboard.listen(); await once(dashboard.server, 'listening'); t.after(() => dashboard.close());
  const base = `http://127.0.0.1:${dashboard.server.address().port}`;
  const status = (await (await fetch(`${base}/api/public/one/state`)).json()).worker.status;
  const pending = fetch(base + status.current.thumbnail);
  await started;
  worker.status.current.title = 'Second programme';
  release(Buffer.from('jpeg'));
  assert.equal((await pending).status, 404);
});
