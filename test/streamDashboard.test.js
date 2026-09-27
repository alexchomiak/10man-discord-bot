'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createStreamDashboard, parseExternalChannels, publicStatus, scopedStatus } = require('../src/streamDashboard');

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

test('dashboard authenticates reads and commands, routes moves/reorders, and falls back to nickname', async t => {
  const staticDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stream-dashboard-test-'));
  await fs.writeFile(path.join(staticDir, 'index.html'), '<!doctype html><head></head><body>Player</body>');
  t.after(() => fs.rm(staticDir, { recursive: true, force: true }));
  const calls = []; const nicknames = [];
  const member = { nickname: null, manageable: true, setNickname: async name => nicknames.push(name) };
  const hiddenChannelId = '444444444444444444';
  const guild = { id: guildId, name: 'Test server', members: { cache: new Map(), fetch: async () => member },
    channels: { fetch: async () => new Map([[channelId, { id: channelId, name: 'Movies', type: 2 }],
      [hiddenChannelId, { id: hiddenChannelId, name: 'Hidden', type: 2 }]]) } };
  const externalGuild = { id: externalGuildId, name: 'Friends server',
    channels: { fetch: async id => id === externalChannelId
      ? { id, name: 'Watch party', type: 2 } : null } };
  const user = { id: userId, globalName: 'Streamer', username: 'streamer', displayAvatarURL: () => 'https://cdn.discordapp.com/a.png' };
  const guildCache = new Map([[guildId, guild], [externalGuildId, externalGuild]]);
  const client = { guilds: { cache: guildCache, fetch: async id => guildCache.get(id) || null },
    users: { cache: new Map([[userId, user]]), fetch: async () => user } };
  let online = true;
  const activeWorker = { id: 'one', userId, connectedAt: 1,
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
    externalChannels: parseExternalChannels(`${externalGuildId}:${externalChannelId}`),
    host: '127.0.0.1', port: 0, staticDir, log: () => {} });
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
  const state = await (await request(`/api/state?guildId=${guildId}`)).json();
  assert.equal(state.workers.length,2);
  assert.equal(state.workers[1].online,false);
  assert.equal(state.workers[0].profile.displayName,'Streamer');
  assert(!JSON.stringify(state).includes('ApiKey'));
  const channels = await (await request(`/api/guilds/${guildId}/channels`)).json();
  assert.deepEqual(channels.channels.map(channel=>channel.name),['Movies','Watch party']);
  assert.deepEqual(channels.channels[1], { guildId: externalGuildId, guildName: 'Friends server',
    id: externalChannelId, name: 'Watch party', type: 2, external: true });
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
  assert.equal(calls[4].payload.queueId,queueId);
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
  const scopedPlay = await (await publicFetch('/api/public/one/actions', { operation: 'play',
    source: 'https://youtube.com/watch?v=test', guildId: externalGuildId, channelId: externalChannelId })).json();
  assert.equal(scopedPlay.ok, true);
  assert.equal(calls.at(-1).workerId, 'one');
  assert.equal(calls.at(-1).payload.guildId, guildId);
  assert.equal(calls.at(-1).payload.channelId, channelId);
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
  assert.equal((await publicFetch('/api/public/one/actions', { operation: 'pause' })).status, 404);
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
