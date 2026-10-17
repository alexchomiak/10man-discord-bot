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
