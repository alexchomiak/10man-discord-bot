'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StreamSchedules } = require('../src/streamSchedules');
const input = now => ({ sources: ['https://example.com/video'], startAt: new Date(now + 1000).toISOString(), guildId: '12345678901234567', channelId: '23456789012345678' });
test('durable claim prevents restart replay; offline grace and cancel are retained', async () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedules-')); const filePath = path.join(dir, 'jobs.json');
 let now = Date.now(), online = false, calls = 0, finish;
 const broker = { getWorker: () => online ? {} : null, request: async () => { calls++; return new Promise(resolve => { finish = resolve; }); } };
 const store = new StreamSchedules({ broker, filePath, now: () => now });
 try {
  const a = await store.add('one', input(now)); now += 2000; await store.tick(); assert.equal(store.list('one')[0].status, 'pending');
  online = true; const ticking = store.tick(); await store.serial; await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  await store.tick(); assert.equal(calls, 1);
  const restarted = new StreamSchedules({ broker, filePath, now: () => now }); await restarted.tick(); assert.equal(calls, 1); assert.equal(restarted.list('one')[0].status, 'failed');
  finish({ ok: true }); await ticking; assert.equal(store.list('one')[0].status, 'completed');
  const b = await store.add('one', input(now)); await store.cancel('one', b.id); assert.equal(store.list('one').find(j => j.id === b.id).status, 'cancelled');
  online = false; const c = await store.add('one', input(now)); now += 302000; await store.tick(); assert.equal(store.list('one').find(j => j.id === c.id).status, 'failed');
  assert.equal(a.sources[0], 'https://example.com/video');
 } finally { await store.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('bad input rejected; ambiguous command failure never retries', async () => {
 let now = Date.now(), calls = 0;
 const store = new StreamSchedules({ now: () => now, broker: { getWorker: () => ({}), request: async () => { calls++; throw new Error('command timeout'); } } });
 await assert.rejects(store.add('one', { ...input(now), startAt: '2030-01-01T00:00:00' }));
 await assert.rejects(store.add('one', { ...input(now), sources: ['file:///secret'] }));
 await store.add('one', input(now)); now += 2000; await store.tick(); await store.tick(); assert.equal(calls, 1); assert.equal(store.list('one')[0].error, 'command timeout');
});
test('dispatch serializes per worker but proceeds across workers', async () => {
 let now = Date.now(); const calls = [], finishes = [];
 const store = new StreamSchedules({ now: () => now, broker: { getWorker: () => ({}), request: async (_, __, worker) => { calls.push(worker); return new Promise(resolve => finishes.push(resolve)); } } });
 await store.add('one', input(now)); await store.add('one', input(now)); await store.add('two', input(now)); now += 2000;
 const ticking = store.tick(); await store.serial; await new Promise(resolve => setImmediate(resolve)); await store.tick(); assert.deepEqual(calls, ['one', 'two']);
 finishes.splice(0).forEach(resolve => resolve({ ok: true })); await ticking;
 const next = store.tick(); await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, ['one', 'two', 'one']); finishes[0]({ ok: true }); await next;
});
test('scheduled playback interrupts active or paused content and preserves queue and pipeline', async () => {
 const { StreamManager } = require('../src/streambot/streamManager');
 for (const paused of [false, true]) {
  const active = { queueId: 'active', title: 'Old' }, other = { queueId: 'other', title: 'Queued' };
  const pipeline = { activeWriter: active, enqueue: [active, other], ready: Promise.resolve(true) };
  const link = { guildId: 'g', channelId: 'c', pipeline, paused, pausedSession: paused ? active : null };
  const cancelled = []; const manager = Object.create(StreamManager.prototype);
  Object.assign(manager, { config: { streamQueueLimit: 100 }, client: { channels: { cache: new Map([['c', {}]]) } }, voiceLink: link,
   _serialize: fn => fn(), _video: async () => ({}), preparePlayback: async v => v,
   _ensureVoiceLink: async () => ({ ok: true, voiceLink: link }), _ensurePipeline: () => pipeline,
   _piece: (_, args) => ({ ...args, queueId: args.title }), _refreshMusicQueue: async () => {},
   _cancelPiece: piece => cancelled.push(piece), _pump: () => {} });
  const result = await manager.startScheduled({ guildId: 'g', channelId: 'c', entries: [{ title: 'Scheduled 1' }, { title: 'Scheduled 2' }], nickname: 'Movie night', scheduleId: 'event' });
  assert.equal(result.ok, true); assert.deepEqual(pipeline.enqueue.map(piece => piece.title), ['Scheduled 1', 'Scheduled 2', 'Queued']);
  assert.deepEqual(pipeline.enqueue.slice(0, 2).map(piece => piece.scheduledNickname), ['Movie night', 'Movie night']);
  assert.equal(pipeline.enqueue[2].scheduledNickname, undefined);
  assert.equal(manager._reopenSession(link, pipeline.enqueue[0]).scheduledNickname, 'Movie night');
  assert.equal(manager._copyQueuedPiece(link, pipeline.enqueue[0]).scheduleId, 'event');
  assert.deepEqual(cancelled, [active]); assert.equal(manager.voiceLink.pipeline, pipeline); assert.equal(link.paused, false); assert.equal(link.pausedSession, null);
 }
});
test('idle ticks do not write and failed persistence rolls back expiry and claims', async () => {
 let now = Date.now(), saves = 0, requests = 0;
 const store = new StreamSchedules({ now: () => now, broker: { getWorker: () => ({}), request: async () => { requests++; return { ok: true }; } } });
 const save = store._save.bind(store); store._save = async () => { saves++; await save(); };
 await store.tick(); assert.equal(saves, 0);
 await store.add('one', input(now)); await store.tick(); assert.equal(saves, 1);
 now += 302000; await store.add('two', input(now)); now += 2000;
 store._save = async () => { throw new Error('disk failure'); };
 await assert.rejects(store.tick(), /disk failure/); assert.equal(requests, 0);
 assert.deepEqual(store.jobs.map(job => job.status), ['pending', 'pending']);
 store._save = save; await store.tick(); assert.equal(requests, 1);
 assert.deepEqual(store.jobs.map(job => job.status).sort(), ['completed', 'failed']);
});
test('scheduled control prepares only first ordinary source and rejects late preparation', async () => {
 const { StreamControl } = require('../src/streambot/control');
 const calls = [], starts = [];
 const manager = { status: () => null, startScheduled: async args => { starts.push(args); return { ok: true }; } };
 const control = new StreamControl({ streamManager: manager, sourceResolver: async input => { calls.push(input); return { available: true, streamUrl: input, kind: 'direct' }; } });
 const payload = { guildId: 'g', channelId: 'c', sources: ['https://first.example', 'https://later.example'], dispatchDeadline: Date.now() + 60000 };
 assert.equal((await control.execute('scheduled-play', payload)).ok, true); assert.deepEqual(calls, [payload.sources[0]]); assert.equal(starts[0].entries[1].streamUrl, undefined);
 // A fake clock advances while asynchronous resolution is in flight.
 const originalNow = Date.now; let clock = originalNow();
 Date.now = () => clock;
 try {
  const lateControl = new StreamControl({ streamManager: manager, sourceResolver: async input => { clock += 60001; return { available: true, streamUrl: input, kind: 'direct' }; } });
  const result = await lateControl.execute('scheduled-play', { ...payload, dispatchDeadline: clock + 60000 }); assert.equal(result.ok, false); assert.equal(starts.length, 1);
 } finally { Date.now = originalNow; }
});

test('legacy schedules load without migration; pending edits keep ID and survive restart', async () => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-edit-')); const filePath = path.join(dir, 'jobs.json');
 let now = Date.now(), payload;
 const broker = { getWorker: () => ({ availableChannels: [{ guildId: '12345678901234567', id: '23456789012345678', guildName: 'Friends', name: 'Movies' }] }), request: async (_, body) => { payload = body; return { ok: true }; } };
 const legacy = { id: 'legacy-id', workerId: 'one', ...input(now), status: 'pending' };
 fs.writeFileSync(filePath, JSON.stringify([legacy]));
 const original = fs.readFileSync(filePath, 'utf8');
 try {
  const store = new StreamSchedules({ broker, filePath, now: () => now });
  assert.equal(fs.readFileSync(filePath, 'utf8'), original);
  assert.equal(store.jobs[0].nickname, undefined);
  assert.equal(store.list('one')[0].channelName, 'Movies');
  const edited = await store.update('one', legacy.id, { ...input(now), sources: ['newslug'], nickname: 'Movie night' });
  assert.equal(edited.id, legacy.id); assert.equal(edited.status, 'pending'); assert.equal(edited.nickname, 'Movie night');
  const restarted = new StreamSchedules({ broker, filePath, now: () => now });
  assert.equal(restarted.jobs[0].nickname, 'Movie night'); assert.equal(restarted.jobs[0].id, legacy.id);
  now += 2000; await restarted.tick();
  assert.equal(payload.nickname, 'Movie night'); assert.equal(payload.scheduleId, legacy.id); assert.deepEqual(payload.sources, ['newslug']);
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('schedule edit validation and persistence failures roll back every field', async () => {
 const now = Date.now();
 const store = new StreamSchedules({ broker: { getWorker: () => null }, now: () => now });
 const job = await store.add('one', input(now)); const before = JSON.stringify(store.jobs);
 await assert.rejects(store.update('one', job.id, { ...input(now), startAt: new Date(now - 100).toISOString() }));
 await assert.rejects(store.update('one', job.id, { ...input(now), nickname: {} }));
 assert.equal(JSON.stringify(store.jobs), before);
 store._save = async () => { store.jobs = []; throw new Error('disk full'); };
 await assert.rejects(store.update('one', job.id, { ...input(now), sources: ['different'], nickname: 'Changed' }), /disk full/);
 assert.equal(JSON.stringify(store.jobs), before);
 assert.equal(await store.update('another-worker', job.id, input(now)), null);
});

test('dispatch claim wins edit race; running and terminal schedules reject edits', async () => {
 let now = Date.now(), finish;
 const store = new StreamSchedules({ now: () => now, broker: { getWorker: () => ({}), request: () => new Promise(resolve => { finish = resolve; }) } });
 const job = await store.add('one', input(now)); now += 2000;
 const ticking = store.tick();
 await store.serial; await new Promise(resolve => setImmediate(resolve));
 await assert.rejects(store.update('one', job.id, input(now)), /Only pending/);
 finish({ ok: true }); await ticking;
 await assert.rejects(store.update('one', job.id, input(now)), /Only pending/);
 const another = await store.add('one', input(now)); await store.cancel('one', another.id);
 await assert.rejects(store.update('one', another.id, input(now)), /Only pending/);
});

test('schedule nickname truncates at a Unicode-safe word boundary and blank is optional', async () => {
 const now = Date.now(); const store = new StreamSchedules({ now: () => now, broker: { getWorker: () => null } });
 const job = await store.add('one', { ...input(now), nickname: 'A fantastic movie night with friends 👩‍👩‍👧‍👦' });
 assert.ok(job.nickname.length <= 32); assert.ok(job.nickname.endsWith('...'));
 assert.equal((await store.update('one', job.id, { ...input(now), nickname: '  ' })).nickname, null);
});
