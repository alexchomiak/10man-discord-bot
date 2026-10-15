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
  const presence = new PlayerPresence(client, manager, { assetIntervalMs: 0 });
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
test('Unicode title stays capped and paused position remains canonical', () => {
  const manager = { session: null, voiceLink: { paused: true,
    pausedPositionSec: 3661, pausedSession: { title: '😀'.repeat(200), totalDurationSec: 72000 } },
  positionOf: () => 99999 };
  const state = snapshot(manager);
  assert.equal(Array.from(state.title).length, 90);
  assert.ok(state.title.endsWith('…'));
  assert.equal(state.hover, undefined);
  assert.equal(state.position, 3661);
});

test('chapter music and live derive canonical positions without invented totals', () => {
  const piece = { title: 'Mix', musicMode: true, totalDurationSec: 600,
    chapters: [{ title: 'First', startSec: 0 }, { title: 'Second', startSec: 120 }] };
  const manager = { voiceLink: {}, session: piece, positionOf: () => 150,
    _currentChapter: () => ({ ...piece.chapters[1], index: 1 }) };
  let state = snapshot(manager, 1000000);
  assert.equal(state.title, 'Second');
  assert.equal(state.position, 30);
  assert.equal(state.duration, 480);
  assert.equal(state.start, 970000);
  piece.isLive = true; piece.contentTitle = 'Live Show'; piece.musicMode = false;
  manager._currentChapter = () => null;
  state = snapshot(manager);
  assert.equal(state.duration, null);
  assert.equal(state.title, 'Live Show');
  assert.equal(state.position, 150);
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
  assert.equal(activity.details, undefined);
  assert.equal(activity.state, 'Other - Paused');
  assert.equal(activity.timestamps?.start, undefined);
  assert.equal(activity.timestamps?.end, undefined);
  manager.voiceLink.paused = false; pos = 300; sync();
  activity = packets.at(-1).d.activities[0];
  assert.ok(Math.abs(Date.now() - activity.timestamps.start - 300000) < 1000);
});

test('artwork resolves once and keeps badge image without hover text', async t => {
  const { client, manager, presence, packets, sync } = fixture(t);
  client.user.displayAvatarURL = () => 'https://cdn.example/avatar.png';
  manager.session = { title: 'Now Playing', thumbnail: 'https://source.example/image.jpg', totalDurationSec: 600 };
  manager.positionOf = () => 12;
  let calls = 0;
  presence.resolveAssets = async (_client, _app, ...urls) => {
    calls++; return urls.map(url => ({ url, external_asset_path: url.includes('avatar') ? 'mp:external/avatar' : 'mp:external/art' }));
  };
  sync();
  await new Promise(resolve => setImmediate(resolve));
  sync();
  const activity = packets.at(-1).d.activities[0];
  assert.equal(activity.assets.large_image, 'mp:external/art');
  assert.equal(activity.assets.small_image, 'mp:external/avatar');
  assert.equal(activity.assets.small_text, undefined);
  assert.equal(activity.assets.large_text, 'Now Playing');
  assert.deepEqual(activity.buttons, ['Open Player']);
  sync(); assert.equal(calls, 2);
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
    sync();
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
  assert.equal(packets.at(-1).d.activities[0].name, 'Stream');
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

test('Discord CDN avatar resolves through external assets before artwork', async t => {
  const { client, manager, presence, sync, packets } = fixture(t);
  const avatar = 'https://cdn.discordapp.com/embed/avatars/0.png';
  client.user.displayAvatarURL = () => avatar;
  manager.session = { title: 'Video', thumbnail: 'https://image.example/art.jpg' };
  const calls = [];
  presence.resolveAssets = async (_client, _app, ...urls) => {
    calls.push(urls);
    return [{ url: urls[0], external_asset_path: urls[0] === avatar ? 'mp:external/avatar' : 'mp:external/art' }];
  };
  sync(); await new Promise(resolve => setImmediate(resolve)); sync();
  const activity = packets.at(-1).d.activities[0];
  assert.deepEqual(calls, [[avatar], ['https://image.example/art.jpg']]);
  assert.equal(activity.assets.large_image, 'mp:external/art');
  assert.equal(activity.assets.small_image, 'mp:external/avatar');
  assert.equal(activity.assets.large_text, 'Video');
  assert.equal(activity.assets.small_text, undefined);
  sync(); assert.equal(calls.length, 2);
});

test('stale avatar resolution releases reservations and retries for new context', async t => {
  const { client, manager, presence, sync, packets } = fixture(t);
  const avatar = 'https://cdn.discordapp.com/embed/avatars/0.png';
  client.user.displayAvatarURL = () => avatar;
  manager.session = { title: 'Old', thumbnail: 'https://image.example/shared.jpg' };
  let settle;
  let calls = 0;
  presence.resolveAssets = () => { calls++; return new Promise(resolve => { settle = resolve; }); };
  sync(); await Promise.resolve();
  manager.voiceLink.channelId = 'new-channel';
  manager.session = { title: 'New', thumbnail: 'https://image.example/shared.jpg' };
  sync();
  presence.resolveAssets = async (_client, _app, url) => {
    calls++; return [{ url, external_asset_path: url === avatar ? 'mp:external/avatar' : 'mp:external/art' }];
  };
  settle([{ external_asset_path: 'mp:external/stale' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(![...presence.assetCache.values()].includes('mp:external/stale'));
  presence.assetNextAt = 0;
  sync(); await new Promise(resolve => setImmediate(resolve)); sync();
  assert.equal(calls, 3);
  const activity = packets.at(-1).d.activities[0];
  assert.equal(activity.assets.small_image, 'mp:external/avatar');
  assert.equal(activity.assets.large_image, 'mp:external/art');
});

test('thumbnail failure never prevents resolved avatar badge or fallback, without retries', async t => {
  const { client, manager, presence, sync, packets } = fixture(t);
  const avatar = 'https://cdn.discordapp.com/embed/avatars/0.png';
  client.user.displayAvatarURL = () => avatar;
  manager.session = { title: 'Video', thumbnail: 'https://image.example/broken.jpg' };
  const calls = [];
  presence.resolveAssets = async (_client, _app, url) => {
    calls.push(url);
    if (url !== avatar) throw new Error('not available');
    return [{ url, external_asset_path: 'mp:external/avatar' }];
  };
  sync(); await new Promise(resolve => setImmediate(resolve)); sync();
  const activity = packets.at(-1).d.activities[0];
  assert.equal(activity.assets.large_image, 'mp:external/avatar');
  assert.equal(activity.assets.small_image, 'mp:external/avatar');
  assert.equal(activity.assets.large_text, 'Video');
  assert.equal(activity.assets.small_text, undefined);
  assert.deepEqual(calls, [avatar, 'https://image.example/broken.jpg']);
  presence.assetNextAt = 0;
  sync(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
});

test('steady playback at 15/30/60 seconds sends no tooltip-driven presence updates', t => {
  const { manager, packets, sync } = fixture(t);
  let now = 1000000;
  let position = 0;
  t.mock.method(Date, 'now', () => now);
  manager.session = { title: 'Video', queueId: 'track', startedAt: now, startOffsetSec: 0, totalDurationSec: 600 };
  manager.positionOf = () => position;
  sync();
  const initial = packets[0].d.activities[0];
  assert.equal(initial.timestamps.start, 1000000);
  assert.equal(initial.timestamps.end, 1600000);
  for (const elapsed of [15, 30, 60]) {
    now = 1000000 + elapsed * 1000; position = elapsed; sync();
  }
  assert.equal(packets.length, 1);
});

test('explicit seek reanchors timestamps while chapter and programme changes still publish', t => {
  const { manager, packets, sync } = fixture(t);
  let now = 1000000;
  let position = 10;
  t.mock.method(Date, 'now', () => now);
  const piece = manager.session = { title: 'Mix', queueId: 'mix', startedAt: now,
    musicMode: true, totalDurationSec: 600,
    chapters: [{ title: 'Repeated chapter', startSec: 0 }, { title: 'Repeated chapter', startSec: 120 }] };
  manager.positionOf = () => position;
  manager._currentChapter = (_piece, at) => ({ ...piece.chapters[at < 120 ? 0 : 1], index: at < 120 ? 0 : 1 });
  sync();
  position = 60; now += 10000;
  sync(true);
  assert.equal(packets.length, 2);
  assert.equal(packets.at(-1).d.activities[0].timestamps.start, now - 60000);
  position = 130; now += 10000; sync();
  assert.equal(packets.length, 3);
  assert.equal(packets.at(-1).d.activities[0].timestamps.start, now - 10000);
  piece.chapters = null; manager._currentChapter = () => null;
  piece.musicMode = false; piece.contentTitle = 'New programme'; now += 15000; sync();
  assert.equal(packets.length, 4);
  assert.equal(packets.at(-1).d.activities[0].name, 'New programme');
});

test('manager seek explicitly requests a presence timestamp refresh', async () => {
  const { StreamManager } = require('../src/streambot/streamManager');
  const calls = [];
  const manager = { _reopenSession: (_link, session, { offsetSec }) => ({ ...session, startOffsetSec: offsetSec }),
    _cancelPiece: () => {}, playerPresence: { sync: force => calls.push(force) } };
  const link = { pipeline: { enqueue: [], writerTask: Promise.resolve() } };
  await StreamManager.prototype._seekSession.call(manager, link, { queueId: 'track' }, 45);
  assert.deepEqual(calls, [true]);
  assert.equal(manager.session.startOffsetSec, 45);
});

test('Jellyfin and ShareTV artwork resolve only scoped public capabilities in real presence payloads', async t => {
  const { client, manager, presence, packets, sync } = fixture(t);
  const avatar = 'https://cdn.discordapp.com/avatars/111111111111111111/avatar.png';
  client.user.displayAvatarURL = () => avatar;
  const proxy = 'https://player.example/api/public/worker-two/artwork/' + 'a'.repeat(32) + '.jpg';
  const calls = [];
  manager.presenceArtwork = { sync() {}, url: () => proxy };
  presence.resolveAssets = async (ignored, appId, url) => {
    calls.push(url); return [{ url, external_asset_path: url === avatar ? 'mp:external/avatar' : 'mp:external/protected-art' }];
  };
  for (const sourceKind of ['jellyfin', 'sharetv']) {
    manager.session = { sourceKind, title: 'Movie', thumbnail: 'http://private/art.jpg?api_key=secret&token=signed' };
    sync();
    await presence.assetFlight; sync();
    assert.equal(packets.at(-1).d.activities[0].assets.large_image, 'mp:external/protected-art');
  }
  assert.ok(calls.includes(proxy));
  assert.ok(calls.every(url => !url.includes('secret') && !url.includes('private') && !url.includes('signed')));
  manager.presenceArtwork.url = () => null; sync();
  assert.equal(packets.at(-1).d.activities[0].assets.large_image, 'mp:external/avatar');
});

test('dynamic activity title/status/source replace only the previously owned activity', t => {
  const { client, manager, packets, sync } = fixture(t);
  client.presence.set({ activities: [{ name: 'Custom Status', state: 'hello', type: 4 },
    { name: 'Other activity', applicationId: manager.config.playerPresenceApplicationId, type: 0 }] });
  manager.session = { title: 'The Batman', sourceKind: 'jellyfin', totalDurationSec: 600 };
  manager.positionOf = () => 12;
  sync();
  let activities = packets.at(-1).d.activities;
  let activity = activities.at(-1);
  assert.equal(activity.name, 'The Batman');
  assert.equal(activity.details, undefined);
  assert.equal(activity.state, 'Jellyfin - Now Playing');
  assert.deepEqual(activity.buttons, ['Open Player']);
  assert.equal(activity.timestamps.end - activity.timestamps.start, 600000);
  manager.session = { title: 'Next Video', sourceKind: 'youtube', totalDurationSec: 300 };
  sync();
  activities = packets.at(-1).d.activities;
  assert.equal(activities.length, 3);
  assert.equal(activities.at(-1).name, 'Next Video');
  assert.equal(activities.at(-1).state, 'YouTube - Now Playing');
  assert.ok(!activities.some(item => item.name === 'The Batman'));
  assert.ok(activities.some(item => item.name === 'Other activity'));
  manager.session.sourceKind = 'sharetv'; sync();
  assert.equal(packets.at(-1).d.activities.at(-1).state, 'ShareTV - Now Playing');
  manager.session.sourceKind = 'direct'; sync();
  assert.equal(packets.at(-1).d.activities.at(-1).state, 'Other - Now Playing');
  manager.voiceLink.paused = true; manager.voiceLink.pausedSession = manager.session; sync();
  assert.equal(packets.at(-1).d.activities.at(-1).state, 'Other - Paused');
  manager.voiceLink = null; sync();
  assert.equal(packets.at(-1).d.activities.length, 2);
});

test('new protected artwork resolves promptly after avatar and drains latest work after an old flight', async t => {
  const { client, manager, presence, sync } = fixture(t);
  const avatar = 'https://cdn.discordapp.com/embed/avatars/0.png';
  client.user.displayAvatarURL = () => avatar;
  let proxy = null;
  manager.presenceArtwork = { sync() {}, url: () => proxy };
  manager.session = { title: 'Movie', sourceKind: 'jellyfin' };
  const calls = [];
  presence.resolveAssets = async (_client, _app, url) => {
    calls.push(url); return [{ url, external_asset_path: 'mp:external/resolved' }];
  };
  sync(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [avatar]);
  proxy = 'https://player.example/artwork/new.jpg';
  sync(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [avatar, proxy]);
  let settle;
  presence.resolveAssets = (_client, _app, url) => {
    calls.push(url);
    if (url.endsWith('old.jpg')) return new Promise(resolve => { settle = resolve; });
    return Promise.resolve([{ url, external_asset_path: 'mp:external/latest' }]);
  };
  proxy = 'https://player.example/artwork/old.jpg'; sync(); await Promise.resolve();
  proxy = 'https://player.example/artwork/latest.jpg'; sync();
  assert.equal(calls.at(-1), 'https://player.example/artwork/old.jpg');
  settle([{ external_asset_path: 'mp:external/stale' }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.at(-1), proxy);
  assert.equal(presence.assetCache.get(`${manager.config.playerPresenceApplicationId}:${proxy}`), 'mp:external/latest');
});

test('one-second asset budget schedules a dedicated wake without waiting for observer polling', async t => {
  const { manager, presence, sync } = fixture(t);
  let now = 1000000;
  t.mock.method(Date, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  presence.assetIntervalMs = 1000;
  const calls = [];
  presence.resolveAssets = async (_client, _app, url) => { calls.push(url); return [{ url, external_asset_path: 'mp:external/image' }]; };
  manager.session = { thumbnail: 'https://image.example/first.jpg' };
  sync(); await new Promise(resolve => setImmediate(resolve));
  manager.session.thumbnail = 'https://image.example/latest.jpg'; sync();
  assert.equal(calls.length, 1);
  assert.ok(presence.assetTimer);
  manager.session.thumbnail = 'https://image.example/actual-latest.jpg'; sync();
  now += 1000; t.mock.timers.tick(1000);
  await Promise.resolve(); await presence.assetFlight;
  assert.deepEqual(calls, ['https://image.example/first.jpg', 'https://image.example/actual-latest.jpg']);
});

test('filler activities show a human title instead of internal placeholder/buffer labels', t => {
  const { manager, packets, sync } = fixture(t);
  for (const title of ['placeholder', 'buffer']) {
    manager.session = { title, isFiller: true };
    sync();
    const activity = packets.at(-1).d.activities[0];
    assert.equal(activity.name, 'Ready to play');
    assert.equal(activity.details, undefined);
    assert.equal(activity.state, 'Other - Ready');
    assert.equal(activity.timestamps?.start, undefined);
  }
});


test('ShareTV EPG description serializes in middle, clips Unicode, and clears on same queue programme changes', t => {
  const { manager, packets, sync } = fixture(t);
  manager.session = { queueId: 'same', sourceKind: 'sharetv', contentTitle: 'Programme', programmeDescription: '  A\n description\twith  spaces.  ' };
  sync();
  assert.equal(packets.at(-1).d.activities[0].details, 'A description with spaces.');
  assert.equal(packets.at(-1).d.activities[0].state, 'ShareTV - Now Playing');
  for (const description of ['x'.repeat(300), '😀'.repeat(300)]) {
    manager.session.programmeDescription = description; sync();
    const details = packets.at(-1).d.activities[0].details;
    assert.equal(Array.from(details).length, 128);
    assert.ok(details.endsWith('…'));
    assert.ok(!details.includes('\ufffd'));
  }
  for (const description of ['', null, undefined, 'x']) {
    manager.session.programmeDescription = description; sync();
    assert.equal(packets.at(-1).d.activities[0].details, undefined);
  }
  manager.session.programmeDescription = 'Watch https://private.example/api?token=secret now\u0000'; sync();
  assert.equal(packets.at(-1).d.activities[0].details, 'Watch Stream now');
  manager.voiceLink.paused = true; manager.voiceLink.pausedSession = manager.session; sync();
  assert.equal(packets.at(-1).d.activities[0].details, 'Watch Stream now');
  assert.equal(packets.at(-1).d.activities[0].state, 'ShareTV - Paused');
});

test('manager EPG hook updates same queued activity and clears absent descriptions; reopen and move preserve metadata', async t => {
  const { StreamManager } = require('../src/streambot/streamManager');
  const { client, manager: view, packets, sync } = fixture(t);
  const manager = new StreamManager(client);
  manager.contentNickname.update = () => {};
  manager.playerPresence = { sync };
  const link = view.voiceLink;
  const piece = view.session = manager._piece(link, { queueId: 'channel', sourceKind: 'sharetv', shareTvChannel: true,
    contentTitle: 'Old programme', programmeDescription: 'Old description', streamUrl: 'https://stream.example' });
  sync();
  await manager.shareTvNicknameRefresh.onProgramme(piece, 'Next programme', { description: 'Next description' });
  assert.equal(packets.at(-1).d.activities[0].name, 'Next programme');
  assert.equal(packets.at(-1).d.activities[0].details, 'Next description');
  for (const copy of [manager._reopenSession(link, piece, { offsetSec: 42 }), manager._copyQueuedPiece({ ...link, channelId: 'moved' }, piece)]) {
    assert.equal(copy.programmeDescription, 'Next description');
    assert.equal(copy.queueId, 'channel');
  }
  for (const programme of [{ description: null }, {}]) {
    piece.programmeDescription = 'Stale description';
    await manager.shareTvNicknameRefresh.onProgramme(piece, 'Another programme', programme);
    assert.equal(piece.programmeDescription, null);
    assert.equal(packets.at(-1).d.activities[0].details, undefined);
  }
});

test('provider metadata uses distinct presence title/details without changing queue titles or chapter names', t => {
  const { jellyfinPresence, ytdlpPresence, presenceText } = require('../src/streambot/presenceMetadata');
  assert.equal(presenceText('&lt;b&gt;Text&lt;/b&gt; data:text/plain,private ftp://secret.example/file'), 'Text');
  const { manager, packets, sync } = fixture(t);
  const examples = [
    [{ Type: 'Movie', Name: 'The Movie', Overview: '<p>A brave &amp; curious hero.</p>' }, 'The Movie', 'A brave & curious hero.'],
    [{ Type: 'Movie', Name: 'The Batman', ProductionYear: 2022, Overview: 'Synopsis.' }, 'The Batman (2022)', 'Synopsis.'],
    [{ Type: 'Movie', Name: 'The Batman (2022)', ProductionYear: 2022 }, 'The Batman (2022)', undefined],
    [{ Type: 'Episode', Name: 'The Fly', SeriesName: 'Breaking Bad', ProductionYear: 2008, ParentIndexNumber: 3, IndexNumber: 3 }, 'Breaking Bad', 'The Fly - S3E3'],
    [{ Type: 'Episode', Name: 'Special', SeriesName: 'Series', ParentIndexNumber: 0, IndexNumber: 2 }, 'Series', 'Special - S0E2'],
    [{ Type: 'Episode', Name: 'Unnamed season', SeriesName: 'Series', IndexNumber: 3 }, 'Series', 'Unnamed season - E3'],
    [{ Type: 'Episode', Name: 'No indices', SeriesName: 'Series' }, 'Series', 'No indices'],
    [{ Type: 'Episode', SeriesName: 'Series', ParentIndexNumber: 3 }, 'Series', 'S3'],
    [{ Name: 'Music album', ProductionYear: 2022, Overview: 'An album.' }, 'Music album', 'An album.']
  ];
  for (const [item, title, details] of examples) {
    manager.session = { title: 'Original queue label', sourceKind: 'jellyfin', ...jellyfinPresence(item) };
    sync();
    const activity = packets.at(-1).d.activities[0];
    assert.equal(activity.name, title);
    assert.equal(activity.details, details);
    assert.equal(activity.state, 'Jellyfin - Now Playing');
    assert.equal(manager.session.title, 'Original queue label');
  }
  for (const [data, expected] of [
    [{ description: '<p>A useful synopsis.</p>', channel: 'Creator' }, 'A useful synopsis.'],
    [{ description: 'https://private.example/api?token=secret', channel: 'Creator' }, 'Creator'],
    [{ description: 'Links https://example.com/very-long-promotion-and-tracking', uploader: 'Uploader' }, 'Uploader'],
    [{ channel: 'Only channel' }, 'Only channel'], [{}, undefined]
  ]) {
    manager.session = { title: 'Video', sourceKind: 'youtube', ...ytdlpPresence(data) }; sync();
    assert.equal(packets.at(-1).d.activities[0].details, expected);
  }
  manager.session = { title: 'Direct', sourceKind: 'direct', presenceDetails: 'Stale metadata' }; sync();
  assert.equal(packets.at(-1).d.activities[0].details, undefined);
  manager.session = { title: 'Mix', sourceKind: 'youtube', musicMode: true, presenceTitle: 'Album', presenceDetails: 'Creator' };
  manager._currentChapter = () => ({ title: 'Track title', index: 0, startSec: 0 });
  sync();
  assert.equal(packets.at(-1).d.activities[0].name, 'Track title');
});

test('presence metadata survives pause/reopen/move and sanitizes URLs, markup, controls and long text', t => {
  const { StreamManager } = require('../src/streambot/streamManager');
  const { manager, packets, sync } = fixture(t);
  const copier = { _piece: (_link, args) => args, _reopenSession: StreamManager.prototype._reopenSession };
  const piece = { queueId: 'episode', title: 'Queue title', presenceTitle: 'Series', presenceDetails: '<b>Synopsis</b>\u0000 ' + '😀'.repeat(150) + ' https://secret.example?api_key=secret', sourceKind: 'jellyfin' };
  for (const copy of [piece, copier._reopenSession(manager.voiceLink, piece), StreamManager.prototype._copyQueuedPiece.call(copier, manager.voiceLink, piece)]) {
    manager.session = copy; sync();
    assert.equal(copy.presenceTitle, 'Series');
    assert.equal(copy.presenceDetails, piece.presenceDetails);
    const activity = packets.at(-1).d.activities[0];
    assert.equal(activity.name, 'Series');
    assert.equal(Array.from(activity.details).length, 128);
    assert.ok(!/secret|<b>|\u0000/.test(activity.details));
  }
  manager.voiceLink.paused = true; manager.voiceLink.pausedSession = piece; sync();
  assert.equal(packets.at(-1).d.activities[0].state, 'Jellyfin - Paused');
  assert.equal(packets.at(-1).d.activities[0].name, 'Series');
});


test('Jellyfin movie year accepts release years only and retains the existing title cap', t => {
  const { jellyfinPresence } = require('../src/streambot/presenceMetadata');
  const { manager, packets, sync } = fixture(t);
  for (const year of [undefined, null, '2022', 2022.5, NaN, 0, 999, 1800, 10000, 2101]) {
    const metadata = jellyfinPresence({ Type: 'Movie', Name: 'The Batman', ProductionYear: year });
    assert.equal(metadata.presenceTitle, 'The Batman');
  }
  manager.session = { title: 'Original movie queue label', sourceKind: 'jellyfin',
    ...jellyfinPresence({ Type: 'Movie', Name: '😀'.repeat(100), ProductionYear: 2022 }) };
  sync();
  assert.equal(Array.from(packets.at(-1).d.activities[0].name).length, 90);
  assert.ok(packets.at(-1).d.activities[0].name.endsWith('…'));
  assert.equal(manager.session.title, 'Original movie queue label');
});
