'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkerChannelDiscovery, parseDashboardServerIds, canJoinChannel, sanitizeAvailableChannels, CHANNEL_CACHE_MS } = require('../src/workerChannels');
const { StreamControl } = require('../src/streambot/control');
const A = '111111111111111111', B = '222222222222222222', C = '333333333333333333';
const member = { id: C };
function channel(id, name, permissions = ['VIEW_CHANNEL', 'CONNECT'], type = 'GUILD_VOICE') {
  return { id, name, type, permissionsFor: self => { assert.equal(self, member); return { has: value => permissions.includes(value) }; } };
}
function guild(id, channels, counter = () => {}) {
  return { id, name: `Server ${id}`, members: { me: member }, channels: { fetch: async () => { counter(); return new Map(channels.map(ch => [ch.id, ch])); } } };
}
function client(guilds) { return { user: { id: C }, guilds: { cache: new Map(guilds.map(g => [g.id, g])), fetch: async () => { throw new Error('Not joined'); } } }; }

test('server CSV trims, deduplicates, defaults empty and rejects malformed IDs', () => {
  assert.deepEqual(parseDashboardServerIds(` ${A},${B},${A}, `), [A, B]);
  assert.deepEqual(parseDashboardServerIds(''), []);
  assert.throws(() => parseDashboardServerIds(`${A}:123`), /SERVER_IDS/);
});

test('worker config reads server IDs independently of deprecated channel settings', () => {
  const { loadConfig } = require('../src/streambot/config');
  const previous = { SELF_BOT_TOKEN: process.env.SELF_BOT_TOKEN, STREAM_DASHBOARD_SERVER_IDS: process.env.STREAM_DASHBOARD_SERVER_IDS };
  try {
    process.env.SELF_BOT_TOKEN = 'fixture';
    process.env.STREAM_DASHBOARD_SERVER_IDS = `${A},${B}`;
    assert.deepEqual(loadConfig().dashboardServerIds, [A, B]);
  } finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test('discover effective self permissions; deny private, disconnected and text channels', async () => {
  const discovery = new WorkerChannelDiscovery(client([guild(A, [channel(A, 'Voice'), channel(B, 'Private', ['CONNECT']),
    channel(C, 'No connect', ['VIEW_CHANNEL']), channel('444444444444444444', 'Text', ['VIEW_CHANNEL', 'CONNECT'], 0)])]));
  const result = await discovery.list();
  assert.deepEqual(result.availableChannels.map(ch => ch.name), ['Voice']);
  assert.equal(result.availableChannels[0].guildName, `Server ${A}`);
});

test('timeout members are excluded unless effective administrator', () => {
  const timed = { communicationDisabledUntilTimestamp: Date.now() + 60000 };
  assert.equal(canJoinChannel({ type: 2, permissionsFor: () => ({ has: name => name !== 'ADMINISTRATOR' }) }, timed), false);
  assert.equal(canJoinChannel({ type: 13, permissionsFor: () => ({ has: () => true }) }, timed), true);
});

test('worker server allowlist and distinct memberships ignore legacy channel restrictions', async () => {
  const guildA = guild(A, [channel(A, 'First'), channel(C, 'Other')]), guildB = guild(B, [channel(B, 'Second')]);
  const first = new WorkerChannelDiscovery(client([guildA, guildB]), { dashboardServerIds: [A], externalChannels: [{ guildId: B, id: B }], dashboardChannelIds: [A] });
  assert.deepEqual((await first.list()).availableChannels.map(ch => ch.name), ['First', 'Other']);
  assert.deepEqual((await first.list({ guildIds: [B] })).availableChannels, []);
  const second = new WorkerChannelDiscovery(client([guildB]));
  assert.deepEqual((await second.list()).availableChannels.map(ch => ch.guildId), [B]);
});

test('failed server fetch does not hide accessible servers; stage channel included', async () => {
  const unavailable = { id: A, name: 'Unavailable', members: { me: member }, channels: { fetch: async () => { throw new Error('No access'); } } };
  const discovery = new WorkerChannelDiscovery(client([unavailable, guild(B, [channel(C, 'Stage', ['VIEW_CHANNEL', 'CONNECT'], 13)])]));
  const result = await discovery.list();
  assert.equal(result.ok, true);
  assert.deepEqual(result.unavailableGuildIds, [A]);
  assert.equal(result.availableChannels[0].name, 'Stage');
});

test('five-minute cache, explicit reconnect refresh and one in-flight discovery', async () => {
  let now = 0, fetches = 0;
  const discovery = new WorkerChannelDiscovery(client([guild(A, [channel(B, 'Voice')], () => fetches++)]), {}, () => now);
  await Promise.all([discovery.list(), discovery.list()]);
  assert.equal(fetches, 1);
  assert.equal((await discovery.list()).cached, true);
  now = CHANNEL_CACHE_MS;
  await discovery.list();
  assert.equal(fetches, 2);
  await discovery.list({ refresh: true });
  assert.equal(fetches, 3);
});

test('list-channels validates payload and returns only serializable descriptors', async () => {
  const control = new StreamControl({ config: { dashboardServerIds: [A] }, client: client([guild(A, [channel(B, 'Voice')])]) });
  assert.equal((await control.execute('list-channels', { guildIds: ['bad'] })).ok, false);
  assert.equal((await control.execute('list-channels')).availableChannels[0].id, B);
  assert.doesNotThrow(() => JSON.stringify(control.channelDiscovery.cache.result));
});

test('broker descriptors remove invalid, duplicate and extraneous data without old 100 cap', () => {
  const descriptors = Array.from({ length: 500 }, (_, i) => ({ guildId: A, guildName: 'Server',
    id: String(100000000000000000n + BigInt(i)), name: 'Voice', type: 2, secret: 'omit' }));
  const result = sanitizeAvailableChannels([...descriptors, descriptors[0], { id: 'bad' }]);
  assert.equal(result.length, 500);
  assert.equal(result[0].secret, undefined);
});

test('cached occupants include self and bots, cap avatars and update presence without REST', async () => {
  let fetches = 0;
  const g = guild(A, [channel(B, 'Voice'), channel(C, 'Empty')], () => fetches++);
  g.voiceStates = { cache: new Map() }; g.members.cache = new Map();
  for (let i = 0; i < 10; i++) {
    const id = String(100000000000000000n + BigInt(i));
    g.voiceStates.cache.set(id, { id, channelId: B });
    g.members.cache.set(id, { id, displayName: `Member ${i}`, user: { bot: i === 0 }, displayAvatarURL: () => `https://cdn.discordapp.com/avatars/${id}/avatar.png` });
  }
  const discovery = new WorkerChannelDiscovery(client([g]));
  const first = await discovery.list();
  const occupied = first.availableChannels.find(ch => ch.id === B);
  assert.equal(occupied.memberCount, 10); assert.equal(occupied.members.length, 8);
  assert.equal(occupied.members[0].displayName, 'Member 0');
  assert.ok(occupied.members[0].avatarUrl.startsWith('https://cdn.discordapp.com/'));
  assert.deepEqual(first.availableChannels.find(ch => ch.id === C).members, []);
  g.voiceStates.cache.clear();
  const next = await discovery.list();
  assert.equal(next.availableChannels.find(ch => ch.id === B).memberCount, 0);
  assert.equal(fetches, 1);
});

test('unknown cached member uses cached user identity without fetching member', async () => {
  const g = guild(A, [channel(B, 'Voice')]);
  g.voiceStates = { cache: new Map([[C, { id: C, channelId: B }]]) };
  g.members.fetch = async () => { throw new Error('No member REST allowed'); };
  const c = client([g]); c.users = { cache: new Map([[C, { username: 'Cached user' }]]) };
  const result = await new WorkerChannelDiscovery(c).list();
  assert.equal(result.availableChannels[0].members[0].displayName, 'Cached user');
  assert.equal(result.availableChannels[0].members[0].avatarUrl, null);
});

test('global occupant budget stays below broker payload limit and retains total counts', () => {
  const { MAX_TOTAL_MEMBERS, BROKER_MAX_PAYLOAD } = require('../src/workerChannels');
  const channels = Array.from({ length: 5000 }, (_, i) => ({ guildId: A, guildName: '\uffff'.repeat(100),
    id: String(100000000000000000n + BigInt(i)), name: '\uffff'.repeat(100), type: 'GUILD_STAGE_VOICE', memberCount: 100,
    members: Array.from({ length: 8 }, (_, j) => ({ id: String(200000000000000000n + BigInt(j)), displayName: '\uffff'.repeat(64), avatarUrl: 'https://cdn.discordapp.com/' + 'a'.repeat(220) })) }));
  const result = sanitizeAvailableChannels(channels);
  assert.equal(result.reduce((sum, ch) => sum + ch.members.length, 0), MAX_TOTAL_MEMBERS);
  assert.equal(result.at(-1).memberCount, 100);
  assert.ok(Buffer.byteLength(JSON.stringify({ type: 'available-channels', channels: result })) < BROKER_MAX_PAYLOAD);
});

test('voice state updates publish one coalesced cached update and clean up on close', t => {
  const { EventEmitter } = require('node:events');
  const { StreamBrokerClient } = require('../src/streambot/brokerClient');
  const { WebSocket } = require('ws');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = new EventEmitter(), sent = []; let cachedReads = 0;
  const worker = new StreamBrokerClient({ streamManager: { client: c }, control: {
    execute: () => { throw new Error('No discovery REST'); },
    channelDiscovery: { cached: () => { cachedReads++; return { availableChannels: [{ id: B, memberCount: 1, members: [] }] }; } }
  } });
  worker.socket = { readyState: WebSocket.OPEN, send: value => sent.push(JSON.parse(value)), terminate: () => {} };
  c.emit('voiceStateUpdate'); c.emit('voiceStateUpdate');
  t.mock.timers.tick(999); assert.equal(sent.length, 0);
  t.mock.timers.tick(1); assert.equal(sent.length, 1); assert.equal(cachedReads, 1);
  c.emit('voiceStateUpdate'); worker.close(); t.mock.timers.tick(1000);
  assert.equal(sent.length, 1); assert.equal(c.listenerCount('voiceStateUpdate'), 0);
});
