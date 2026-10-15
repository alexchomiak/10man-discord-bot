'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PlayerPresence } = require('../src/streambot/playerPresence');
const { Client } = require('discord.js-selfbot-v13');

function fixture(t) {
  const client = new Client({});
  const packets = [];
  client.ws.broadcast = packet => packets.push(packet);
  // Exercise the installed library's full presence parse/patch/serialization.
  client.user = { setPresence: data => client.presence.set(data) };
  const manager = { config: { playerPresenceApplicationId: '123456789012345678',
    dashboardBaseUrl: 'https://player.example/watch/?discard=1#qr', workerId: 'worker-two' },
  voiceLink: { guildId: 'guild', channelId: 'voice' } };
  const presence = new PlayerPresence(client, manager);
  t.after(() => presence.close());
  const sync = force => { presence.lastSentAt = 0; presence.sync(force); };
  return { client, manager, presence, packets, sync };
}

test('publishes actual library button payload, preserves custom status, deduplicates, clears on leave', t => {
  const { client, manager, presence, packets, sync } = fixture(t);
  client.presence.set({ activities: [{ name: 'Custom Status', type: 4, state: 'hello' }] });
  packets.length = 0;
  sync();
  assert.equal(packets.length, 1);
  const activities = packets[0].d.activities;
  assert.equal(activities[0].state, 'hello');
  assert.equal(activities[1].application_id, manager.config.playerPresenceApplicationId);
  assert.deepEqual(activities[1].buttons, ['Open Player']);
  assert.deepEqual(activities[1].metadata.button_urls, ['https://player.example/watch/worker-two']);
  sync();
  assert.equal(packets.length, 1);
  manager.voiceLink = null;
  sync();
  assert.equal(packets.length, 2);
  assert.equal(packets[1].d.activities.length, 1);
  assert.equal(presence.owned, false);
});

test('uses random access code and refreshes URL, moves and reconnects', t => {
  const { manager, packets, sync } = fixture(t);
  manager.config.dashboardRandomCodes = true;
  manager.config.dashboardAccessCode = 'abcdef';
  sync();
  assert.equal(packets[0].d.activities[0].metadata.button_urls[0], 'https://player.example/watch/abcdef');
  manager.config.dashboardAccessCode = 'ghijkl';
  manager.config.dashboardBaseUrl = 'https://new.example';
  sync();
  assert.equal(packets[1].d.activities[0].metadata.button_urls[0], 'https://new.example/ghijkl');
  manager.voiceLink.channelId = 'moved'; sync(); sync(true);
  assert.equal(packets.length, 4);
  assert.equal(packets[3].d.activities.length, 1);
  manager.voiceLink.closing = Promise.resolve(); sync();
  assert.deepEqual(packets[4].d.activities, []);
});

test('disabled or invalid configuration emits nothing; failures never throw or repeat unchanged', t => {
  const { client, manager, packets, sync } = fixture(t);
  manager.config.playerPresenceApplicationId = ''; sync();
  manager.config.playerPresenceApplicationId = 'fake'; sync();
  manager.config.playerPresenceApplicationId = '123456789012345678';
  manager.config.dashboardBaseUrl = 'javascript:alert(1)'; sync();
  assert.equal(packets.length, 0);
  manager.config.dashboardBaseUrl = 'https://player.example';
  let attempts = 0;
  client.user.setPresence = () => { attempts++; throw new Error('offline'); };
  assert.doesNotThrow(() => sync());
  sync();
  assert.equal(attempts, 1);
});

test('coalesces rapid state changes into one bounded timer and closes observers', t => {
  const { manager, presence, packets, sync } = fixture(t);
  sync();
  manager.voiceLink.channelId = 'move'; presence.sync();
  const timer = presence.timer;
  assert.ok(timer);
  manager.config.dashboardAccessCode = 'mnopqr'; presence.sync();
  assert.equal(presence.timer, timer);
  assert.equal(packets.length, 1);
  presence.close();
  assert.equal(presence.closed, true);
  presence.sync(true);
  assert.equal(packets.length, 1);
});

const { snapshot } = require('../src/streambot/playerPresence');
test('Unicode title/hover limits preserve complete hour-long paused timing', () => {
  const manager = { session: null, voiceLink: { paused: true,
    pausedPositionSec: 3661, pausedSession: { title: '😀'.repeat(200), totalDurationSec: 72000 } },
  positionOf: () => 99999 };
  const state = snapshot(manager);
  assert.equal(Array.from(state.title).length, 90);
  assert.ok(state.title.endsWith('…'));
  assert.ok(Array.from(state.hover).length <= 128);
  assert.ok(state.hover.endsWith(' - 1:01:01/20:00:00 - Paused'));
  assert.equal(state.position, 3661);
});

test('chapter music and live derive canonical positions without invented totals', () => {
  const piece = { title: 'Mix', musicMode: true, totalDurationSec: 600,
    chapters: [{ title: 'First', startSec: 0 }, { title: 'Second', startSec: 120 }] };
  const manager = { voiceLink: {}, session: piece, positionOf: () => 150,
    _currentChapter: () => ({ ...piece.chapters[1], index: 1 }) };
  let state = snapshot(manager, 1000000);
  assert.equal(state.title, 'Second');
  assert.equal(state.hover, 'Second - 0:30/8:00 - Playing');
  assert.equal(state.start, 970000);
  piece.isLive = true; piece.contentTitle = 'Live Show'; piece.musicMode = false;
  manager._currentChapter = () => null;
  state = snapshot(manager);
  assert.equal(state.duration, null);
  assert.equal(state.hover, 'Live Show - 2:30 elapsed - Live - Playing');
});

test('real serialization freezes paused timestamps and updates seek/resume timing', t => {
  const { manager, packets, sync } = fixture(t);
  manager.session = { title: 'Video', totalDurationSec: 600 };
  let pos = 120;
  manager.positionOf = () => pos;
  sync();
  let activity = packets.at(-1).d.activities[0];
  assert.equal(activity.type, 3);
  assert.ok(Math.abs(activity.timestamps.end - activity.timestamps.start - 600000) < 2);
  manager.voiceLink.paused = true;
  manager.voiceLink.pausedSession = manager.session;
  manager.voiceLink.pausedPositionSec = 180;
  sync();
  activity = packets.at(-1).d.activities[0];
  assert.equal(activity.state, 'Paused');
  assert.equal(activity.timestamps?.start, undefined);
  assert.equal(activity.timestamps?.end, undefined);
  manager.voiceLink.paused = false; pos = 300; sync();
  activity = packets.at(-1).d.activities[0];
  assert.ok(Math.abs(Date.now() - activity.timestamps.start - 300000) < 1000);
});

test('artwork resolves once, uses worker avatar badge, and serializes exact tooltip', async t => {
  const { client, manager, presence, packets, sync } = fixture(t);
  client.user.displayAvatarURL = () => 'https://cdn.example/avatar.png';
  manager.session = { title: 'Now Playing', thumbnail: 'https://source.example/image.jpg', totalDurationSec: 600 };
  manager.positionOf = () => 12;
  let calls = 0;
  presence.resolveAssets = async (_client, _app, ...urls) => {
    calls++; return urls.map((url, i) => ({ url, external_asset_path: `mp:external/${i}` }));
  };
  sync();
  await new Promise(resolve => setImmediate(resolve));
  sync();
  const activity = packets.at(-1).d.activities[0];
  assert.equal(activity.assets.large_image, 'mp:external/0');
  assert.equal(activity.assets.small_image, 'mp:external/1');
  assert.equal(activity.assets.small_text, 'Now Playing - 0:12/10:00 - Playing');
  assert.deepEqual(activity.buttons, ['Open Player']);
  sync(); assert.equal(calls, 1);
});

test('stale artwork is ignored and lookups/cache stay bounded across signed URLs', async t => {
  const { client, manager, presence, sync } = fixture(t);
  client.user.displayAvatarURL = () => 'https://cdn.example/avatar.png';
  let settle;
  let calls = 0;
  presence.resolveAssets = () => { calls++; return new Promise(resolve => { settle = resolve; }); };
  manager.session = { thumbnail: 'https://source.example/a?signature=old' };
  sync(); await Promise.resolve();
  manager.session.thumbnail = 'https://source.example/b?signature=new';
  sync();
  assert.equal(calls, 1);
  settle([{ external_asset_path: 'mp:external/old' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(![...presence.assetCache.values()].includes('mp:external/old'));
  presence.resolveAssets = async () => { calls++; throw new Error('optional failure'); };
  for (let i = 0; i < 50; i++) {
    manager.session.thumbnail = `https://source.example/a?signature=${i}`;
    presence.assetNextAt = 0; sync();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(presence.assetCache.size <= 32);
  const before = calls; sync(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, before);
  presence.close();
  assert.equal(presence.assetCache.size, 0);
});

test('credential-bearing thumbnails and URL titles never reach Discord', async t => {
  const { client, manager, presence, sync, packets } = fixture(t);
  client.user.displayAvatarURL = () => 'https://cdn.example/avatar.png';
  const sentUrls = [];
  presence.resolveAssets = async (_client, _app, ...urls) => { sentUrls.push(...urls); return []; };
  manager.session = { title: 'https://jellyfin.example/item?api_key=private',
    thumbnail: 'https://jellyfin.example/Images/Primary?ApiKey=private' };
  sync(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sentUrls, ['https://cdn.example/avatar.png']);
  assert.equal(packets.at(-1).d.activities[0].details, 'Stream');
  assert.ok(!JSON.stringify(packets).includes('private'));
});

test('closing invalidates pending artwork without publishing its result', async t => {
  const { manager, presence, sync, packets } = fixture(t);
  let settle;
  presence.resolveAssets = () => new Promise(resolve => { settle = resolve; });
  manager.session = { thumbnail: 'https://image.example/current.jpg' };
  sync(); await Promise.resolve();
  const before = packets.length;
  presence.close();
  settle([{ external_asset_path: 'mp:external/late' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(packets.length, before);
  assert.equal(presence.assetCache.size, 0);
});

test('Discord CDN artwork and avatar need no external request', async t => {
  const { client, manager, presence, sync, packets } = fixture(t);
  client.user.displayAvatarURL = () => 'https://cdn.discordapp.com/avatars/worker/avatar.png';
  manager.session = { title: 'Video', thumbnail: 'https://media.discordapp.net/attachments/art.png' };
  let calls = 0;
  presence.resolveAssets = async () => { calls++; return []; };
  sync(); await new Promise(resolve => setImmediate(resolve));
  const activity = packets.at(-1).d.activities[0];
  assert.equal(activity.assets.large_image, 'mp:attachments/art.png');
  assert.equal(activity.assets.small_image, 'mp:avatars/worker/avatar.png');
  assert.equal(calls, 0);
});

test('stale first artwork request keeps direct avatar badge and releases reservations', async t => {
  const { client, manager, presence, sync, packets } = fixture(t);
  client.user.displayAvatarURL = () => 'https://cdn.discordapp.com/avatars/worker/avatar.png';
  manager.session = { title: 'Old', thumbnail: 'https://image.example/shared.jpg' };
  let settle;
  let calls = 0;
  presence.resolveAssets = async () => { calls++; return new Promise(resolve => { settle = resolve; }); };
  sync(); await Promise.resolve();
  manager.voiceLink.channelId = 'new-channel';
  manager.session = { title: 'New', thumbnail: 'https://image.example/shared.jpg' };
  sync();
  assert.equal(packets.at(-1).d.activities[0].assets.small_image, 'mp:avatars/worker/avatar.png');
  assert.equal(packets.at(-1).d.activities[0].assets.large_image, 'mp:avatars/worker/avatar.png');
  settle([{ external_asset_path: 'mp:external/stale' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(presence.assetCache.has(`${manager.config.playerPresenceApplicationId}:https://image.example/shared.jpg`), false);
  presence.assetNextAt = 0;
  sync(); await Promise.resolve();
  assert.equal(calls, 2);
  settle([{ external_asset_path: 'mp:external/current' }]);
  await new Promise(resolve => setImmediate(resolve)); sync();
  assert.equal(packets.at(-1).d.activities[0].assets.large_image, 'mp:external/current');
});

test('genuine external artwork failure keeps large avatar fallback without retries', async t => {
  const { client, manager, presence, sync, packets } = fixture(t);
  client.user.displayAvatarURL = () => 'https://cdn.discordapp.com/avatars/worker/avatar.png';
  manager.session = { title: 'Video', thumbnail: 'https://image.example/broken.jpg' };
  let calls = 0;
  presence.resolveAssets = async () => { calls++; throw new Error('not available'); };
  sync(); await new Promise(resolve => setImmediate(resolve));
  presence.assetNextAt = 0; sync();
  const activity = packets.at(-1).d.activities[0];
  assert.equal(activity.assets.large_image, 'mp:avatars/worker/avatar.png');
  assert.equal(activity.assets.small_image, 'mp:avatars/worker/avatar.png');
  assert.ok(activity.assets.small_text.endsWith(' - Playing'));
  assert.equal(calls, 1);
});
