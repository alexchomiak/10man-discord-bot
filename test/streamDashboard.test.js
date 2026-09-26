'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createStreamDashboard, publicStatus } = require('../src/streamDashboard');

const guildId = '111111111111111111';
const channelId = '222222222222222222';
const userId = '333333333333333333';

test('dashboard strips resolved media URLs from its public status', () => {
  const status = publicStatus({ guildId, channelId, streamUrl: 'https://secret.example/?ApiKey=private',
    current: { id: 'a', title: 'A', thumbnail: 'https://images.example/a.jpg', durationSec: 100 },
    queue: [{ id: 'b', title: 'B' }] });
  assert.equal(status.current.title, 'A');
  assert.equal(status.current.thumbnail, 'https://images.example/a.jpg');
  assert.equal(status.queue[0].id, 'b');
  assert(!JSON.stringify(status).includes('ApiKey'));
});

test('dashboard authenticates reads and commands, routes moves/reorders, and falls back to nickname', async t => {
  const calls = []; const nicknames = [];
  const member = { nickname: null, manageable: true, setNickname: async name => nicknames.push(name) };
  const hiddenChannelId = '444444444444444444';
  const guild = { id: guildId, name: 'Test server', members: { cache: new Map(), fetch: async () => member },
    channels: { fetch: async () => new Map([[channelId, { id: channelId, name: 'Movies', type: 2 }],
      [hiddenChannelId, { id: hiddenChannelId, name: 'Hidden', type: 2 }]]) } };
  const user = { id: userId, globalName: 'Streamer', username: 'streamer', displayAvatarURL: () => 'https://cdn.discordapp.com/a.png' };
  const client = { guilds: { cache: new Map([[guildId, guild]]), fetch: async () => guild },
    users: { cache: new Map([[userId, user]]), fetch: async () => user } };
  const broker = { defaultWorkerId: 'one', listWorkers: () => [{ id: 'one', userId,
    status: { guildId, channelId, streamUrl: 'https://secret/?ApiKey=private',
      queue: [{ id: 'q1', title: 'Next' }], current: { id: 'now', title: 'Playing' } } }],
  getWorker: () => ({ id: 'one', userId }), request: async (operation, payload, workerId) => {
    calls.push({ operation, payload, workerId });
    if (operation === 'set-global-name') return { ok: false, message: 'CAPTCHA_SOLVER_NOT_IMPLEMENTED' };
    return { ok: true, message: 'Done.', status: null };
  } };
  const dashboard = createStreamDashboard({ broker, client, secretQuestion: "What is Alex's nickname?",
    secretAnswer: 'chomes', configuredWorkerIds: ['one','two'], channelIds: [channelId],
    host: '127.0.0.1', port: 0, log: () => {} });
  dashboard.listen(); await once(dashboard.server, 'listening');
  t.after(() => dashboard.close());
  const base = `http://127.0.0.1:${dashboard.server.address().port}`;
  const request = (route, body, answer = 'CHOMES') => fetch(`${base}${route}`, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${answer}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body && JSON.stringify(body)
  });
  const challenge = await (await fetch(`${base}/api/auth-question`)).json();
  assert.equal(challenge.question, "What is Alex's nickname?");
  assert.equal((await request('/api/state', null, 'wrong')).status,401);
  const state = await (await request(`/api/state?guildId=${guildId}`)).json();
  assert.equal(state.workers.length,2);
  assert.equal(state.workers[1].online,false);
  assert.equal(state.workers[0].profile.displayName,'Streamer');
  assert(!JSON.stringify(state).includes('ApiKey'));
  const channels = await (await request(`/api/guilds/${guildId}/channels`)).json();
  assert.deepEqual(channels.channels.map(channel=>channel.name),['Movies']);
  const move = await (await request('/api/workers/one/actions', { operation:'move', guildId, channelId })).json();
  assert.equal(move.ok,true);
  const reorder = await (await request('/api/workers/one/actions', { operation:'reorder', ids:['q1'] })).json();
  assert.equal(reorder.ok,true);
  assert.deepEqual(calls.slice(0,2).map(call=>call.operation),['move','reorder']);
  const name = await (await request('/api/workers/one/actions', { operation:'set-name', guildId, name:'Movie Night' })).json();
  assert.equal(name.scope,'guild');
  assert.deepEqual(nicknames,['Movie Night']);
  assert.equal((await request('/api/workers/one/actions', { operation:'stop' }, 'wrong')).status,401);
});
