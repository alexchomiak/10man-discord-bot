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
  const activeWorker = { id: 'one', userId, connectedAt: 1,
    externalChannels: [{ guildId: externalGuildId, guildName: 'Friends server',
      id: externalChannelId, name: 'Watch party', type: 2, external: true }],
    status: { guildId, channelId, alive: true, inChannel: true, streamUrl: 'https://secret/?ApiKey=private',
      queue: [{ id: 'q1', title: 'Next' }], current: { id: 'now', title: 'Playing' } } };
  const broker = { defaultWorkerId: 'one', listWorkers: () => online ? [activeWorker] : [],
  getWorkerByAccessCode: code => online && code === 'abcdef' ? activeWorker : null,
  getWorker: id => online && id === 'one' ? activeWorker : null, request: async (operation, payload, workerId) => {
    calls.push({ operation, payload, workerId });
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
  assert.deepEqual(state.workers[0].externalChannels, activeWorker.externalChannels);
  assert.deepEqual(state.workers[1].externalChannels, []);
  assert(!JSON.stringify(state).includes('ApiKey'));
  const channels = await (await request(`/api/guilds/${guildId}/channels`)).json();
  assert.deepEqual(channels.channels.map(channel=>channel.name),['Movies']);
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
  assert.equal((await publicFetch('/api/public/one/search?q=x')).status, 400);
  assert.deepEqual((await (await publicFetch('/api/public/one/search?q=music')).json()).results.map(item => item.title), ['Found']);
  assert.deepEqual(searches, [{ query: 'music', page: 1 }, { query: 'music', page: 2 }, { query: 'music', page: 1 }]);
  assert.equal((await publicFetch('/api/public/two/search?q=music')).status, 404);
  const scopedPlay = await (await publicFetch('/api/public/one/actions', { operation: 'play',
    source: 'https://youtube.com/watch?v=test', guildId: externalGuildId, channelId: externalChannelId })).json();
  assert.equal(scopedPlay.ok, true);
  assert.equal(calls.at(-1).workerId, 'one');
  assert.equal(calls.at(-1).payload.guildId, guildId);
  assert.equal(calls.at(-1).payload.channelId, channelId);
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
  activeWorker.status = { ...activeWorker.status, alive: false };
  assert.equal((await publicFetch('/one')).status, 404);
  assert.equal((await publicFetch('/api/public/one/state')).status, 404);
  assert.equal((await publicFetch('/api/public/one/search?q=music')).status, 404);
  assert.equal((await publicFetch('/api/public/one/actions', { operation: 'pause' })).status, 404);
  assert.equal((await publicFetch('/api/public/one/actions', { operation: 'clear-queue' })).status, 404);
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
