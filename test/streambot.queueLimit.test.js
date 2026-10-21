'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { StreamManager } = require('../src/streambot/streamManager');
const { StreamControl } = require('../src/streambot/control');

function harness(queue = [], activeWriter = null) {
  const manager = new StreamManager({ channels: { cache: new Map([['c', {}]]) } }, null, { streamQueueLimit: 100 });
  const pipeline = { enqueue: queue, activeWriter, ready: Promise.resolve(true) };
  const link = { guildId: 'g', channelId: 'c', pipeline };
  manager.voiceLink = link;
  manager._video = async () => ({});
  manager.preparePlayback = async x => x;
  manager._ensureVoiceLink = async () => ({ ok: true, voiceLink: link, reused: true });
  manager._ensurePipeline = () => pipeline;
  manager._piece = (_, args) => ({ ...args, queueId: `q${Math.random()}` });
  manager._gapFillerEnabled = () => true;
  manager._gapFiller = () => ({ isFiller: true });
  manager._refreshMusicQueue = async () => {};
  manager._cancelPiece = () => {};
  manager._pump = () => {};
  return manager;
}
const entries = n => Array.from({ length: n }, (_, i) => ({ queueId: `existing-${i}`, sourceInput: `https://youtube.com/watch?v=${i}`, title: `Video ${i}` }));
const playlist = (manager, n) => manager.startPlaylist({ guildId: 'g', channelId: 'c', entries: entries(n), firstResolved: { available: true, streamUrl: 'https://example.com/video' } });

test('52 video playlist fits 100 slots despite 51 internal buffers', async () => {
  const manager = harness();
  assert.equal((await playlist(manager, 52)).ok, true);
  assert.equal(manager._queuedMediaCount(), 52);
  assert.equal(manager.voiceLink.pipeline.enqueue.length, 103);
});

test('playlist admission is atomic and counts media already waiting', async () => {
  const manager = harness([...entries(48), { isFiller: true }], { queueId: 'active' });
  assert.equal((await playlist(manager, 52)).ok, true);
  const before = [...manager.voiceLink.pipeline.enqueue];
  assert.equal((await playlist(manager, 1)).ok, false);
  assert.deepEqual(manager.voiceLink.pipeline.enqueue, before);
});

test('single and scheduled admissions ignore internal filler', async () => {
  const manager = harness([{ isFiller: true }, ...entries(99)]);
  assert.equal((await manager.start({ guildId: 'g', channelId: 'c', streamUrl: 'https://example.com/video' })).ok, true);
  assert.equal((await manager.start({ guildId: 'g', channelId: 'c', streamUrl: 'https://example.com/video' })).ok, false);
  const scheduled = harness([{ isFiller: true }, ...entries(99)]);
  assert.equal((await scheduled.startScheduled({ guildId: 'g', channelId: 'c', entries: entries(1) })).ok, true);
  assert.equal((await scheduled.startScheduled({ guildId: 'g', channelId: 'c', entries: entries(1) })).ok, false);
});

test('paused current item does not consume waiting capacity', async () => {
  const manager = harness([{ queueId: 'paused' }, { isFiller: true }, ...entries(99)]);
  manager.voiceLink.paused = true;
  manager.voiceLink.pausedSession = { queueId: 'paused' };
  assert.equal((await playlist(manager, 1)).ok, true);
});

test('runtime limit validation, worker isolation, idle DTO and non-destructive lowering', async () => {
  const manager = harness(entries(4));
  const other = harness();
  for (const invalid of [0, -1, 1.1, 1001, '25', null, NaN, Infinity]) assert.equal(manager.setQueueLimit(invalid).ok, false);
  assert.equal(manager.setQueueLimit(2).ok, true);
  assert.equal(manager.voiceLink.pipeline.enqueue.length, 4);
  assert.equal((await playlist(manager, 1)).ok, false);
  assert.equal(other.queueLimit, 100);
  manager.voiceLink = null;
  const control = new StreamControl({ streamManager: manager });
  assert.equal((await control.execute('status')).queueLimit, 2);
  assert.equal((await control.execute('set-queue-limit', { limit: 1000 })).queueLimit, 1000);
  assert.equal((await control.execute('set-queue-limit', { limit: 1001 })).ok, false);
});

test('between-video interval rebuilds pending countdowns without changing active playback', async () => {
  const active = { queueId: 'active', title: 'Playing' };
  const manager = harness(entries(3), active);
  manager._gapFiller = StreamManager.prototype._gapFiller;
  assert.equal(manager.queueGapSeconds, 15);
  assert.equal((await manager.setQueueGap(30)).ok, true);
  assert.equal(manager.voiceLink.pipeline.activeWriter, active);
  assert.deepEqual(manager.voiceLink.pipeline.enqueue.filter(p => p.isFiller).map(p => p.durationSec), [30, 30, 30]);
  assert.equal(manager._queuedMediaCount(), 3);
  await manager.setQueueGap(0);
  assert.equal(manager.voiceLink.pipeline.enqueue.length, 3);
  await manager.setQueueGap(10);
  assert.equal(manager.voiceLink.pipeline.enqueue.filter(p => p.isFiller).length, 3);
  assert.equal(harness().queueGapSeconds, 15);
  manager.musicMode = true;
  await manager.setQueueGap(300);
  assert.equal(manager.voiceLink.pipeline.enqueue.filter(p => p.isFiller).length, 0);
  for (const seconds of [-1, 301, 1.5, '15', null, Infinity]) assert.equal((await manager.setQueueGap(seconds)).ok, false);
  const control = new StreamControl({ streamManager: manager });
  assert.equal((await control.execute('set-queue-gap', { seconds: 0 })).queueGapSeconds, 0);
});

test('interval preserves current countdown and placeholder while updating subsequent gaps', async () => {
  const current = { queueId: 'countdown', isFiller: true, title: 'buffer', durationSec: 15 };
  const placeholder = { queueId: 'placeholder', isFiller: true, title: 'placeholder' };
  const manager = harness([placeholder, ...entries(2)], current);
  manager._gapFiller = StreamManager.prototype._gapFiller;
  await manager.setQueueGap(20);
  assert.equal(current.durationSec, 15);
  assert.equal(manager.voiceLink.pipeline.enqueue[0], placeholder);
  assert.deepEqual(manager.voiceLink.pipeline.enqueue.filter(p => p.title === 'buffer').map(p => p.durationSec), [20]);
});

test('video quality defaults, isolation, validation and custom environment counterpart', async () => {
  const manager = new StreamManager({}, null, {});
  const other = new StreamManager({}, null, {});
  assert.deepEqual(manager.videoQuality(), { width: 1920, height: 1080, bitrateKbps: 4000 });
  for (const value of [{ height: '720', bitrateKbps: 4000 }, { height: 800, bitrateKbps: 4000 }, { height: 720, bitrateKbps: 3500 }]) {
    assert.equal((await manager.setVideoQuality(value)).ok, false);
  }
  assert.equal((await manager.setVideoQuality({ height: 2160, bitrateKbps: 20000 })).ok, true);
  assert.deepEqual(manager.videoQuality(), { width: 3840, height: 2160, bitrateKbps: 20000 });
  assert.equal(other.videoQuality().height, 1080);
  const custom = new StreamManager({}, null, { streamWidth: 1600, streamHeight: 900, streamBitrate: 5000 });
  assert.equal((await custom.setVideoQuality({ height: 720, bitrateKbps: 5000 })).ok, true);
  const control = new StreamControl({ streamManager: custom });
  assert.deepEqual((await control.execute('status')).videoQuality, { width: 1280, height: 720, bitrateKbps: 5000 });
});

function qualityHarness({ paused = false, live = false, filler = false, fail = false } = {}) {
  const manager = new StreamManager({}, null, {});
  const link = { guildId: 'g', channelId: 'c', paused, pausedPositionSec: paused ? 42 : null };
  const active = manager._piece(link, { streamUrl: filler ? 'testsrc=size=1280x720:rate=30' : 'https://example.com/video',
    title: filler ? 'buffer' : 'current', durationSec: filler ? 15 : 300, totalDurationSec: 300,
    isLive: live, isFiller: filler, inputFormat: filler ? 'lavfi' : undefined,
    upNext: filler ? { title: 'Next title' } : null });
  const queued = manager._piece(link, { streamUrl: 'https://example.com/next', title: 'next' });
  const gap = manager._gapFiller(link, queued);
  let applied = null;
  let pumped = 0;
  link.pipeline = { activeWriter: paused ? null : active, enqueue: [gap, queued], writerTask: null,
    feeder: { updateVideoQuality: quality => { if (fail) throw new Error('native failed'); applied = quality; } } };
  link.pausedSession = paused ? active : null;
  manager.voiceLink = link;
  manager.session = paused ? null : active;
  manager.positionOf = () => filler ? 5 : 42;
  manager._video = async () => ({});
  manager.preparePlayback = async x => x;
  manager._cancelPiece = piece => {
    if (!piece) return;
    assert.equal(link.pipeline.qualityUpdating, true);
    piece.control.abort();
    link.pipeline.activeWriter = null;
  };
  manager._pump = () => pumped++;
  return { manager, link, active, queued, gap, get applied() { return applied; }, get pumped() { return pumped; } };
}

test('video quality reopens VOD at its position and preserves queue, transport, music and transition metadata', async () => {
  const h = qualityHarness();
  h.manager.musicMode = true;
  const feeder = h.link.pipeline.feeder;
  const result = await h.manager.setVideoQuality({ height: 1440, bitrateKbps: 8000 });
  assert.equal(result.ok, true);
  assert.equal(h.link.pipeline.feeder, feeder);
  assert.deepEqual(h.applied, { width: 2560, height: 1440, bitrateKbps: 8000 });
  assert.equal(h.link.pipeline.enqueue[0].startOffsetSec, 42);
  assert.equal(h.link.pipeline.enqueue[0].queueId, h.active.queueId);
  assert.equal(h.link.pipeline.enqueue[2], h.queued);
  assert.equal(h.link.pipeline.enqueue[1].queueId, h.gap.queueId);
  assert.deepEqual(h.link.pipeline.enqueue[1].upNext, h.gap.upNext);
  assert.equal(h.manager.musicMode, true);
  assert.equal(h.pumped, 1);
});

test('video quality keeps paused session and queue held, live reopens at head, filler keeps remaining countdown', async () => {
  const paused = qualityHarness({ paused: true });
  assert.equal((await paused.manager.setVideoQuality({ height: 720, bitrateKbps: 2000 })).ok, true);
  assert.equal(paused.link.paused, true);
  assert.equal(paused.link.pausedSession, paused.active);
  assert.equal(paused.link.pausedPositionSec, 42);
  assert.equal(paused.link.pipeline.enqueue.length, 2);
  assert.equal(paused.pumped, 0);
  const live = qualityHarness({ live: true });
  await live.manager.setVideoQuality({ height: 720, bitrateKbps: 2000 });
  assert.equal(live.link.pipeline.enqueue[0].startOffsetSec, 0);
  const filler = qualityHarness({ filler: true });
  await filler.manager.setVideoQuality({ height: 720, bitrateKbps: 2000 });
  assert.equal(filler.link.pipeline.enqueue[0].title, 'buffer');
  assert.equal(filler.link.pipeline.enqueue[0].durationSec, 10);
  assert.deepEqual(filler.link.pipeline.enqueue[0].upNext, filler.active.upNext);
});

test('failed video quality retains actual settings and resumes current item before queue', async () => {
  for (const paused of [false, true]) {
    const h = qualityHarness({ fail: true, paused });
    const old = h.manager.config;
    assert.equal((await h.manager.setVideoQuality({ height: 2160, bitrateKbps: 30000 })).ok, false);
    assert.equal(h.manager.config, old);
    assert.equal(h.link.paused, paused);
    assert.equal(h.link.pipeline.qualityUpdating, false);
    assert.equal(h.link.pipeline.enqueue.at(-1), h.queued);
    assert.equal(h.link.pipeline.enqueue.length, paused ? 2 : 3);
  }
});

test('feeder quality updates video attributes and repair dimensions without replacing the adaptive pacer', () => {
  const { PersistentTrackFeeder } = require('../src/streambot/persistentTrackFeeder');
  const feeder = new PersistentTrackFeeder();
  const attrs = [];
  const pacer = { setBitrate() { throw new Error('must remain adaptive'); } };
  feeder.connection = { _videoPacer: pacer, mediaConnection: { setVideoAttributes: (_, value) => attrs.push(value) } };
  feeder.updateVideoQuality({ width: 3840, height: 2160, bitrateKbps: 30000 });
  assert.deepEqual(attrs[0], { width: 3840, height: 2160, fps: 30, bitrateKbps: 42000 });
  assert.equal(feeder.width, 3840);
  assert.equal(feeder.connection._videoPacer, pacer);
  feeder.connection.mediaConnection.setVideoAttributes = (_, attr) => { if (attr.height === 720) throw new Error('failed'); attrs.push(attr); };
  assert.throws(() => feeder.updateVideoQuality({ width: 1280, height: 720, bitrateKbps: 2000 }));
  assert.equal(feeder.height, 2160);
  assert.equal(attrs.at(-1).height, 2160);
});


test('quality change honors a pending seek replacement while its cancelled writer drains', async () => {
  const h = qualityHarness();
  const pending = h.manager._reopenSession(h.link, h.active, { offsetSec: 120 });
  h.link.pipeline.enqueue.unshift(pending);
  await h.manager.setVideoQuality({ height: 720, bitrateKbps: 2000 });
  assert.equal(h.link.pipeline.enqueue.length, 3);
  assert.equal(h.link.pipeline.enqueue[0].startOffsetSec, 120);
  assert.equal(h.link.pipeline.enqueue.filter(piece => piece.queueId === h.active.queueId).length, 1);
  assert.equal(h.link.pipeline.enqueue.at(-1), h.queued);
});

test('quality encoder shutdown deadline retains settings and arranges recovery without losing the queue', async () => {
  const h = qualityHarness();
  h.link.pipeline.writerTask = new Promise(() => {});
  h.manager._raceWithTimeout = async (_, ms) => { assert.equal(ms, 5000); throw new Error('deadline'); };
  const result = await h.manager.setVideoQuality({ height: 720, bitrateKbps: 2000 });
  assert.equal(result.ok, false);
  assert.equal(h.applied, null);
  assert.equal(h.manager.videoQuality().height, 1080);
  assert.equal(h.link.pipeline.enqueue[0].queueId, h.active.queueId);
  assert.equal(h.link.pipeline.enqueue.at(-1), h.queued);
  assert.equal(h.link.pipeline.qualityUpdating, false);
});


test('native video attributes advertise selected encoder maximum and preserve legacy default', async () => {
  const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const { BaseMediaConnection } = await import(pathToFileURL(path.join(path.dirname(require.resolve('@dank074/discord-video-stream')),
    'client/voice/BaseMediaConnection.js')).href);
  const messages = [];
  const media = { _webRtcParams: { audioSsrc: 1, videoSsrc: 2, rtxSsrc: 3 }, sendOpcode: (_, value) => messages.push(value) };
  BaseMediaConnection.prototype.setVideoAttributes.call(media, true, { width: 3840, height: 2160, fps: 30, bitrateKbps: 42000 });
  assert.equal(messages[0].streams[0].max_bitrate, 42000000);
  assert.deepEqual(messages[0].streams[0].max_resolution, { type: 'fixed', width: 3840, height: 2160 });
  BaseMediaConnection.prototype.setVideoAttributes.call(media, true, { width: 1920, height: 1080, fps: 30 });
  assert.equal(messages[1].streams[0].max_bitrate, 10000000);
});


test('feeder changes quality on one existing Go Live session and retains it for native repair', async () => {
  const { PersistentTrackFeeder } = require('../src/streambot/persistentTrackFeeder');
  let creates = 0;
  const attrs = [];
  const connection = { setPacketizer() {}, mediaConnection: {
    setSpeaking() {}, setVideoAttributes: (_, attr) => attrs.push(attr)
  } };
  const feeder = new PersistentTrackFeeder({ streamer: { createStream: async () => { creates++; return connection; },
    stopStream: () => assert.fail('must keep Go Live') } });
  await feeder.start();
  feeder.updateVideoQuality({ width: 2560, height: 1440, bitrateKbps: 12000 });
  assert.equal(await feeder.start(), connection);
  feeder._restoreVideoTransport();
  assert.equal(creates, 1);
  assert.equal(attrs.at(-1).height, 1440);
  assert.equal(attrs.at(-1).bitrateKbps, 16800);
});

test('YouTube queued selections follow current quality and expire while other inputs remain reusable', () => {
  const manager = new StreamManager({}, null, { streamHeight: 1080 });
  const piece = { sourceKind: 'youtube', sourceInput: 'https://youtube.com/watch?v=test',
    streamUrl: 'https://media.example/video', youtubeSourceHeight: 1080, youtubeResolvedAt: Date.now() };
  assert.equal(manager._needsSourceResolution(piece), false);
  manager.config = { streamHeight: 720 };
  assert.equal(manager._needsSourceResolution(piece), true);
  manager.config = { streamHeight: 2160 };
  assert.equal(manager._needsSourceResolution(piece), true);
  manager.config = { streamHeight: 1080 };
  piece.youtubeResolvedAt -= 61000;
  assert.equal(manager._needsSourceResolution(piece), true);
  piece.sourceKind = 'direct';
  assert.equal(manager._needsSourceResolution(piece), false);
});

test('YouTube quality change refreshes signed media before reopening and preserves paused position', async () => {
  const sources = require('../src/streambot/sources');
  const original = sources.resolveSource;
  try {
    for (const paused of [false, true]) {
      const h = qualityHarness({ paused });
      Object.assign(h.active, { sourceKind: 'youtube', sourceInput: 'https://youtube.com/watch?v=test' });
      sources.resolveSource = async (input, config) => {
        assert.equal(h.active.control.signal.aborted, false);
        assert.equal(config.streamHeight, 2160);
        return { available: true, kind: 'ytdlp', videoUrl: 'https://media.example/4k',
          audioUrl: 'https://media.example/audio', youtubeSourceHeight: 2160, youtubeResolvedAt: Date.now() };
      };
      assert.equal((await h.manager.setVideoQuality({ height: 2160, bitrateKbps: 20000 })).ok, true);
      const replacement = paused ? h.link.pausedSession : h.link.pipeline.enqueue[0];
      assert.equal(replacement.videoUrl, 'https://media.example/4k');
      assert.equal(replacement.youtubeSourceHeight, 2160);
      assert.equal(paused ? h.link.pausedPositionSec : replacement.startOffsetSec, 42);
      assert.equal(h.link.pipeline.enqueue.at(-1), h.queued);
    }
    const h = qualityHarness();
    Object.assign(h.active, { sourceKind: 'youtube', sourceInput: 'https://youtube.com/watch?v=test' });
    sources.resolveSource = async () => ({ available: false });
    assert.equal((await h.manager.setVideoQuality({ height: 720, bitrateKbps: 2000 })).ok, false);
    assert.equal(h.active.control.signal.aborted, false);
    assert.equal(h.manager.videoQuality().height, 1080);
  } finally { sources.resolveSource = original; }
});

test('play resolves against worker quality after manager config replacement', async () => {
  const initial = { streamHeight: 1080 };
  const manager = new StreamManager({}, null, initial);
  manager.start = async args => ({ ok: true });
  const seen = [];
  const control = new StreamControl({ streamManager: manager, config: initial,
    sourceResolver: async (input, config) => {
      seen.push(config.streamHeight);
      return { available: true, kind: 'ytdlp', sourceKind: 'youtube', streamUrl: 'https://media.example/video' };
    } });
  await manager.setVideoQuality({ height: 2160, bitrateKbps: 20000 });
  await control.execute('play', { guildId: 'g', channelId: 'c', source: 'https://youtube.com/watch?v=test' });
  assert.deepEqual(seen, [2160]);
});

test('YouTube resolution latency preserves current position and refuses to replace a newer writer', async () => {
  const sources = require('../src/streambot/sources');
  const original = sources.resolveSource;
  try {
    for (const advances of [false, true]) {
      const h = qualityHarness();
      Object.assign(h.active, { sourceKind: 'youtube', sourceInput: 'https://youtube.com/watch?v=test' });
      let position = 42;
      h.manager.positionOf = () => position;
      sources.resolveSource = async () => {
        position += 10;
        if (advances) h.link.pipeline.activeWriter = h.queued;
        return { available: true, kind: 'ytdlp', videoUrl: 'https://media.example/4k',
          audioUrl: 'https://media.example/audio', youtubeSourceHeight: 2160, youtubeResolvedAt: Date.now() };
      };
      const result = await h.manager.setVideoQuality({ height: 2160, bitrateKbps: 20000 });
      if (advances) {
        assert.equal(result.ok, false);
        assert.equal(h.link.pipeline.activeWriter, h.queued);
        assert.equal(h.queued.control.signal.aborted, false);
        assert.equal(h.manager.videoQuality().height, 1080);
        assert.equal(h.link.pipeline.enqueue.includes(h.active), false);
      } else {
        assert.equal(result.ok, true);
        assert.equal(h.link.pipeline.enqueue[0].startOffsetSec, 52);
      }
    }
  } finally { sources.resolveSource = original; }
});

test('playback pump refreshes already queued singles, deferred playlist entries and music at current height', async () => {
  const sources = require('../src/streambot/sources');
  const original = sources.resolveSource;
  try {
    for (const musicMode of [false, true]) {
      for (const deferred of [false, true]) {
        const manager = new StreamManager({}, null, { streamHeight: 2160 });
        manager.musicMode = musicMode;
        const link = { guildId: 'g', channelId: 'c', paused: false };
        const piece = manager._piece(link, { sourceKind: 'youtube', sourceInput: 'https://youtube.com/watch?v=test',
          streamUrl: deferred ? null : 'https://media.example/cached1080', youtubeSourceHeight: 1080,
          youtubeResolvedAt: Date.now() });
        const pipeline = link.pipeline = { enqueue: [piece], activeWriter: null, writerTask: null, closed: false };
        manager.voiceLink = link;
        let calls = 0;
        sources.resolveSource = async (input, config) => {
          calls++;
          assert.equal(config.streamHeight, 2160);
          assert.equal(config.musicMode, musicMode);
          return { available: true, kind: 'ytdlp', sourceKind: 'youtube', videoUrl: 'https://media.example/2160',
            audioUrl: 'https://media.example/audio', youtubeSourceHeight: 2160, youtubeResolvedAt: Date.now() };
        };
        let observed = false;
        manager.contentNickname.update = current => {
          assert.equal(current.videoUrl, 'https://media.example/2160');
          assert.equal(current.isDash, true);
          assert.equal(current.musicMode, musicMode);
          observed = true;
          // Stop before the real encoder/artwork boundary; resolution is complete.
          pipeline.closed = true;
          current.control.abort();
          throw new Error('fixture complete');
        };
        manager._cancelPiece = () => {};
        manager._reapPiece = async () => {};
        manager._pump(link, {});
        await pipeline.writerTask;
        assert.equal(observed, true);
        assert.equal(calls, 1);
      }
    }
  } finally { sources.resolveSource = original; }
});


test('YouTube quality refresh refuses a live stream that became an archive', async () => {
  const sources = require('../src/streambot/sources');
  const original = sources.resolveSource;
  const h = qualityHarness({ live: true });
  Object.assign(h.active, { sourceKind: 'youtube', sourceInput: 'https://youtube.com/watch?v=test' });
  try {
    sources.resolveSource = async () => ({ available: true, kind: 'ytdlp', isLive: false,
      streamUrl: 'https://media.example/archive' });
    assert.equal((await h.manager.setVideoQuality({ height: 720, bitrateKbps: 2000 })).ok, false);
    assert.equal(h.active.control.signal.aborted, false);
    assert.equal(h.link.pipeline.activeWriter, h.active);
    assert.equal(h.manager.videoQuality().height, 1080);
  } finally { sources.resolveSource = original; }
});
