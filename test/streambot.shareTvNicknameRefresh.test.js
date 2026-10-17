'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ShareTvNicknameRefresh, MAX_TIMER_MS } = require('../src/streambot/shareTvNicknameRefresh');
const { getShareTvPreview, resolveShareTv } = require('../src/streambot/sources');

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function harness(fetchPreview) {
  let now = 1000000, seq = 0, active;
  const timers = new Map(), updates = [];
  const poller = new ShareTvNicknameRefresh({ fetchPreview, now: () => now,
    isCurrent: piece => active === piece,
    onProgramme: (piece, title) => { updates.push(title); piece.contentTitle = title; },
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms, ms }); return id; },
    clearTimer: id => timers.delete(id) });
  const piece = { sourceKind: 'sharetv', shareTvChannel: true, sourceInput: 'channel', control: new AbortController() };
  return { poller, piece, timers, updates, now: () => now,
    activate: p => { active = p; poller.sync(p); },
    advance: async ms => {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); }
      await flush();
    } };
}

test('adaptive metadata polling waits until programme end plus one minute', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return { programme: { title: 'Programme', end_at: 1300 } }; });
  h.activate(h.piece);
  await flush();
  assert.equal(calls, 1);
  assert.equal([...h.timers.values()][0].at, 1360000);
  await h.advance(359999);
  assert.equal(calls, 1);
  await h.advance(1);
  assert.equal(calls, 2);
  assert.equal([...h.timers.values()][0].at, 1420000); // Stale EPG retries in a minute.
});

test('missing, invalid and failed EPG retry after a minute without replacing good content', async () => {
  for (const response of [null, {}, { programme: {} }, { programme: { end_at: 'bad' } }]) {
    const h = harness(async () => response);
    h.piece.contentTitle = 'Good title';
    h.activate(h.piece);
    await flush();
    assert.deepEqual(h.updates, []);
    assert.equal(h.piece.contentTitle, 'Good title');
    assert.equal([...h.timers.values()][0].ms, 60000);
  }
  const h = harness(async () => { throw new Error('offline'); });
  h.activate(h.piece);
  await flush();
  assert.equal([...h.timers.values()][0].ms, 60000);
});

test('only active channel pieces poll; stop and playback abort cancel timers', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return null; });
  for (const overrides of [{ shareTvChannel: false }, { sourceKind: 'youtube' }, { isFiller: true }]) {
    h.activate({ ...h.piece, ...overrides });
    await flush();
  }
  assert.equal(calls, 0);
  h.activate(h.piece);
  await flush();
  assert.equal(h.timers.size, 1);
  h.piece.control.abort();
  assert.equal(h.timers.size, 0);
  await h.advance(60000);
  assert.equal(calls, 1);
});

test('source changes abort and ignore stale metadata, with one request at a time', async () => {
  const requests = [];
  const h = harness((input, signal) => new Promise(resolve => requests.push({ input, signal, resolve })));
  h.activate(h.piece);
  const next = { ...h.piece, sourceInput: 'next', control: new AbortController() };
  h.activate(next);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve({ programme: { title: 'Old', end_at: 1300 } });
  await flush();
  assert.deepEqual(h.updates, []);
  assert.equal(requests.length, 2);
  h.poller.stop();
  requests[1].resolve({ programme: { title: 'New', end_at: 1300 } });
  await flush();
  assert.deepEqual(h.updates, []);
  assert.equal(h.timers.size, 0);
});

test('very distant programme end clamps timers without fetching prematurely', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return { programme: { title: 'Long', end_at: 9999999999 } }; });
  h.activate(h.piece);
  await flush();
  assert.equal([...h.timers.values()][0].ms, MAX_TIMER_MS);
  await h.advance(MAX_TIMER_MS);
  assert.equal(calls, 1);
  assert.equal([...h.timers.values()][0].ms, MAX_TIMER_MS);
});

test('preview refresh uses only optional integration metadata and aborts stalled fetch', async t => {
  let url, options;
  t.mock.method(global, 'fetch', async (u, opts) => { url = u; options = opts; return new Promise(() => {}); });
  const controller = new AbortController();
  const request = getShareTvPreview('channel', { shareTvBase: 'https://tv.example', shareTvApiKey: 'key' }, controller.signal);
  controller.abort();
  assert.equal(await request, null);
  assert.equal(url, 'https://tv.example/api/integrations/discord/share/channel/preview');
  assert.equal(options.headers['X-API-Key'], 'key');
  assert.equal(options.signal.aborted, true);
  assert.equal(options.redirect, 'error');
});

test('range channel classification stays separate from programme/static playback', async t => {
  let mode = 'range', kind = 'channel';
  t.mock.method(global, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ share: {
    mode, kind, channel_id: 4, stream_url: '/api/public/stream/channel', title: 'Channel'
  } }) }));
  const cfg = { shareTvBase: 'https://tv.example' };
  const channel = await resolveShareTv('channel', cfg);
  assert.equal(channel.shareTvChannel, true);
  assert.equal(channel.shareTvMetadata, true);
  mode = 'programs'; kind = 'static';
  for (const values of [['programs', 'temporary'], ['programs', 'static']]) {
    [mode, kind] = values;
    const events = await resolveShareTv('channel', cfg);
    assert.notEqual(events.shareTvChannel, true);
    assert.equal(events.shareTvMetadata, true);
  }
});

test('clearly ended programme cannot overwrite a good title', async () => {
  const h = harness(async () => ({ programme: { title: 'Expired programme', end_at: 900 } }));
  h.piece.contentTitle = 'Current programme';
  h.activate(h.piece);
  await flush();
  assert.deepEqual(h.updates, []);
  assert.equal(h.piece.contentTitle, 'Current programme');
  assert.equal([...h.timers.values()][0].ms, 60000);
});

test('turning off and back on same piece waits for cancellation then refreshes', async () => {
  const requests = [];
  const h = harness((input, signal) => new Promise(resolve => requests.push({ signal, resolve })));
  h.activate(h.piece);
  h.poller.stop();
  h.activate(h.piece);
  assert.equal(requests.length, 1);
  requests[0].resolve(null);
  await flush();
  assert.equal(requests.length, 2);
  requests[1].resolve({ programme: { title: 'Current programme', end_at: 1300 } });
  await flush();
  assert.deepEqual(h.updates, ['Current programme']);
});

test('failed programme image retries metadata after one minute even before EPG ends', async () => {
  const h = harness(async () => ({ programme: { id: 1, title: 'Current', end_at: 5000, icon_url: '/image' } }));
  let programmes = [];
  h.poller.onProgramme = (_piece, _title, programme) => { programmes.push(programme); return false; };
  h.activate(h.piece);
  await flush();
  assert.equal(programmes[0].icon_url, '/image');
  assert.equal([...h.timers.values()][0].ms, 60000);
  h.poller.onProgramme = () => true;
  await h.advance(60000);
  assert.equal([...h.timers.values()][0].at, 5060000);
});

test('multi-event shares refresh nickname, presence, descriptions and artwork without playback changes', async () => {
  const { StreamManager } = require('../src/streambot/streamManager');
  const nicknames = [], presence = [];
  const member = { nickname: null, setNickname: async name => { nicknames.push(name); member.nickname = name; } };
  const manager = new StreamManager({ guilds: { cache: new Map([['g', { members: { me: member } }]]) } }, null,
    { shareTvBase: 'https://tv.example', shareTvApiKey: 'key', playerPresenceApplicationId: '12345678901234567' });
  manager.contentAwareImagePreview = false;
  manager.contentNickname.setEnabled(true);
  let calls = 0;
  const events = [
    { id: 1, title: 'First event', description: 'First description', icon_url: '/first', end_at: 1100 },
    { id: 2, title: 'Second event', description: 'Second description', icon_url: '/second', end_at: 1300 },
    { id: 3, title: 'Second event', description: 'Different event', icon_url: '/third', end_at: 1500 }
  ];
  const h = harness(async () => ({ programme: events[Math.min(calls++, 2)] }));
  const link = manager.voiceLink = { guildId: 'g', paused: false, closing: false };
  const piece = manager.session = manager._piece(link, { guildId: 'g', sourceKind: 'sharetv', sourceInput: 'events',
    shareTvChannel: false, shareTvMetadata: true, title: 'Share label', streamUrl: 'https://tv.example/stream', isLive: true });
  manager.playerPresence = { sync: () => presence.push([piece.contentTitle, piece.programmeDescription, piece.thumbnail]) };
  h.poller.isCurrent = manager.shareTvNicknameRefresh.isCurrent;
  h.poller.onProgramme = manager.shareTvNicknameRefresh.onProgramme;
  manager.shareTvNicknameRefresh = h.poller;
  const control = piece.control, streamUrl = piece.streamUrl;
  manager._reopenSession = () => { throw new Error('metadata must not reopen playback'); };
  h.activate(piece);
  await flush(); await manager.contentNickname.pending;
  assert.deepEqual(nicknames, ['First event']);
  await h.advance(160000); await manager.contentNickname.pending;
  assert.deepEqual(nicknames, ['First event', 'Second event']);
  assert.equal(manager.status().title, 'Second event');
  assert.equal(manager.status().current.title, 'Second event');
  // Presence alone keeps polling when nickname automation is disabled.
  manager.setContentNickname(false);
  assert.equal(h.timers.size, 1);
  await h.advance(200000); await manager.contentNickname.pending;
  assert.deepEqual(presence.at(-1), ['Second event', 'Different event', 'https://tv.example/third']);
  assert.deepEqual(nicknames, ['First event', 'Second event']);
  assert.equal(piece.control, control);
  assert.equal(piece.streamUrl, streamUrl);
  assert.equal(calls, 3);
  assert.equal(h.timers.size, 1);
  piece.control.abort();
  assert.equal(h.timers.size, 0);
});

test('restarting metadata during an artwork upload cannot install a duplicate timer', async () => {
  const h = harness(async () => ({ programme: { title: 'Event', end_at: 1300 } }));
  let release, calls = 0;
  h.poller.onProgramme = () => ++calls === 1 ? new Promise(resolve => { release = resolve; }) : true;
  h.activate(h.piece); await flush();
  h.poller.stop(); h.activate(h.piece); await flush();
  assert.equal(h.timers.size, 1);
  release(true); await flush();
  assert.equal(h.timers.size, 1);
  h.poller.stop();
});

test('multi-event metadata eligibility survives playback reopen and voice moves', () => {
  const { StreamManager } = require('../src/streambot/streamManager');
  const manager = new StreamManager({});
  const link = { guildId: 'g', channelId: 'old' };
  const piece = manager._piece(link, { shareTvChannel: false, shareTvMetadata: true, sourceKind: 'sharetv',
    sourceInput: 'events', streamUrl: 'https://tv.example/stream', contentTitle: 'Event', programmeDescription: 'Description' });
  for (const copy of [manager._reopenSession(link, piece), manager._copyQueuedPiece({ ...link, channelId: 'new' }, piece)]) {
    assert.equal(copy.shareTvMetadata, true);
    assert.equal(copy.shareTvChannel, false);
    assert.equal(copy.contentTitle, 'Event');
    assert.equal(copy.programmeDescription, 'Description');
  }
});
