'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  trackedDemuxers,
  installDemuxerTracker,
  ensureTrackerInstalled,
  closeAllDemuxers
} = require('../src/streambot/demuxGuard');
const { StreamManager } = require('../src/streambot/streamManager');

// --- fake demuxer objects (unit-level; no real ffmpeg / native bindings) ---
function makeFakeDemuxer(opts = {}) {
  const calls = { close: 0, closeSync: 0 };
  const d = {
    calls,
    isClosed: false,
    close: async function close() {
      calls.close += 1;
      if (opts.throwOnClose) throw new Error('close boom');
      this.isClosed = true;
      return undefined;
    }
  };
  if (opts.syncOnly) {
    delete d.close;
    d.closeSync = function closeSync() {
      calls.closeSync += 1;
      if (opts.throwOnClose) throw new Error('closeSync boom');
      this.isClosed = true;
    };
  }
  return d;
}

test('demuxGuard: closeAllDemuxers closes every tracked demuxer and clears the set', async () => {
  const a = makeFakeDemuxer();
  const b = makeFakeDemuxer({ syncOnly: true });
  trackedDemuxers.add(a);
  trackedDemuxers.add(b);
  const closed = await closeAllDemuxers();
  assert.strictEqual(closed, 2, 'both instances must be reported closed');
  assert.strictEqual(a.calls.close, 1, 'async close() must be called exactly once');
  assert.strictEqual(b.calls.closeSync, 1, 'closeSync() used when no async close available');
  assert.strictEqual(trackedDemuxers.size, 0, 'the set must be cleared after closeAllDemuxers');
});

test('demuxGuard: closeAllDemuxers is a no-op (returns 0) when nothing is tracked', async () => {
  assert.strictEqual(trackedDemuxers.size, 0);
  assert.strictEqual(await closeAllDemuxers(), 0);
});

test('demuxGuard: a throwing close() does not prevent the others from closing', async () => {
  const bad = makeFakeDemuxer({ throwOnClose: true });
  const good = makeFakeDemuxer();
  trackedDemuxers.add(bad);
  trackedDemuxers.add(good);
  const closed = await closeAllDemuxers();
  assert.ok(!bad.isClosed, 'faulty instance stays as-is (no crash)');
  assert.strictEqual(good.calls.close, 1, 'healthy instance must still be closed');
  assert.strictEqual(closed, 1, 'only the fulfilled close is counted');
  assert.strictEqual(trackedDemuxers.size, 0, 'set cleared even with a failure');
});

test('demuxGuard: installDemuxerTracker tracks new instances and untracks on close; idempotent', async () => {
  // A stand-in with the same shape as node-av's Demuxer: close/closeSync live
  // on the PROTOTYPE (like the real class), instances are plain objects.
  const FakeCls = class FakeDemuxer {};
  let next = null;
  FakeCls.open = async function open() {
    return (next = Object.create(FakeCls.prototype));
  };
  FakeCls.openSync = function openSync() {
    return (next = Object.create(FakeCls.prototype));
  };
  FakeCls.prototype.close = function close() {
    this.isClosed = true;
  };
  FakeCls.prototype.closeSync = function closeSync() {
    this.isClosed = true;
  };

  installDemuxerTracker(FakeCls);
  const inst = await FakeCls.open('input');
  assert.strictEqual(trackedDemuxers.has(inst), true, 'open() instance must be tracked');
  const instSync = FakeCls.openSync('input');
  assert.strictEqual(trackedDemuxers.has(instSync), true, 'openSync() instance must be tracked');

  // Idempotency: a second install must not double-wrap (which would double-count).
  installDemuxerTracker(FakeCls);
  assert.strictEqual(FakeCls.open.__tracked, true);
  assert.strictEqual(trackedDemuxers.size, 2);

  // Legitimate close untracks, and closeAllDemuxers then finds none.
  await inst.close();
  instSync.closeSync();
  assert.strictEqual(inst.isClosed, true, 'original close body must still run');
  assert.strictEqual(instSync.isClosed, true, 'original closeSync body must still run');
  assert.strictEqual(trackedDemuxers.size, 0, 'close()/closeSync() must remove instances from the set');
  assert.strictEqual(await closeAllDemuxers(), 0);
});

test('demuxGuard: ensureTrackerInstalled patches the shared node-av Demuxer class exactly once', async () => {
  const nodeAv = await import('node-av');
  const before = nodeAv.Demuxer;
  await ensureTrackerInstalled();
  // Same ESM namespace the streaming library imports (single hoisted node-av
  // copy) => the static open the library will call is now our wrapped one.
  assert.strictEqual(nodeAv.Demuxer, before);
  assert.strictEqual(nodeAv.Demuxer.__streambotDemuxerTracker, true, 'tracker flag set');
  assert.strictEqual(nodeAv.Demuxer.open.__tracked, true, 'static open() wrapped');
  // The instance is created via `instanceof Demuxer` in the library, so the
  // prototype (shared, wrapped) is what matters most.
  assert.strictEqual(nodeAv.Demuxer.prototype.close.__tracked, true, 'prototype close() wrapped');
  // Idempotent: a second call must not change the reference.
  await ensureTrackerInstalled();
  assert.strictEqual(nodeAv.Demuxer.open.__tracked, true, 'still wrapped exactly once');
});

test('streamManager: teardown() closes leaked demuxers after the existing kill/destroy steps', async () => {
  const closed = makeFakeDemuxer();
  trackedDemuxers.add(closed);

  const captured = [];
  const session = {
    streamer: { stopStream: () => captured.push('stopStream'), leaveVoice: () => captured.push('leaveVoice') },
    control: { abort: () => captured.push('abort'), signal: { aborted: false } },
    command: { kill: (sig) => captured.push(`kill:${sig}`) },
    output: { destroy: () => captured.push('destroy') }
  };

  const mgr = new StreamManager({ token: 'test-token' }, 'c1', {});
  // session.streamer is the manager's shared streamer (production shape), so
  // the leaveVoice branch fires.
  mgr._streamer = session.streamer;
  await mgr.teardown(session);

  assert.deepStrictEqual(
    captured,
    ['stopStream', 'abort', 'kill:SIGTERM', 'destroy', 'leaveVoice'],
    'the pre-existing teardown ordering must be unchanged'
  );
  assert.strictEqual(closed.calls.close, 1, 'leaked demuxer must be closed during teardown');
  assert.strictEqual(trackedDemuxers.size, 0, 'tracker set must be empty after teardown');
});

test('streamManager: teardown() still succeeds when the demuxer close throws', async () => {
  const bad = makeFakeDemuxer({ throwOnClose: true });
  trackedDemuxers.add(bad);
  const session = {
    streamer: { stopStream() {} },
    control: { abort() {}, signal: { aborted: false } },
    command: null,
    output: null
  };
  const mgr = new StreamManager({ token: 'test-token' }, 'c1', {});
  await assert.doesNotReject(
    () => mgr.teardown(session),
    'a throwing demuxer.close() must not break teardown'
  );
  assert.strictEqual(trackedDemuxers.size, 0, 'set cleared even when close throws');
});

// The muxer's packet timeline is testable without loading native codecs.
const { PersistentNut } = require('../src/streambot/persistentNut');
const { PassThrough } = require('node:stream');
const { PersistentTrackFeeder, TimedTrack } = require('../src/streambot/persistentTrackFeeder');
function fakeAv(writes, options = {}) {
  let opens=0, muxOpens=0, closed=0;
  const streams=[
    {index:0,codecpar:{codecId:27,width:1280,height:720}},
    {index:1,codecpar:{codecId:86076,sampleRate:48000,channels:2}}
  ];
  return {
    AV_NOPTS_VALUE:-9223372036854775808n,
    Demuxer:{open:async()=>{
      opens++;
      return {video:()=>streams[0],audio:()=>streams[1],close:async()=>{closed++;},
        packets:async function*(){
          for (const [index,pts,duration] of [[1,48000n,960n],[0,1000n,33n],[1,48960n,960n],[0,1033n,33n]]) {
            yield {streamIndex:index,pts,dts:pts,duration,
              timeBase:{num:1,den:index===0?1000:48000},data:Buffer.from([0xf8,0xff,0xfe]),free(){}};
          }
        }};
    }},
    Muxer:{open:async(target)=>{
      muxOpens++;let next=0;
      return {addStream:()=>next++,close:async()=>{},writePacket:async(p,i)=>{
        writes.push({index:i,pts:p.pts,dts:p.dts,duration:p.duration});
        if(options.write) await target.write(Buffer.alloc(32));
      }};
    }},
    counts:()=>({opens,muxOpens,closed})
  };
}

test('persistent NUT: one muxer, separate demuxers and monotonic shared A/V timeline',async()=>{
  const writes=[];const av=fakeAv(writes);const p=new PersistentNut({loadAv:async()=>av});
  await p.append(new PassThrough());await p.append(new PassThrough());
  assert.deepStrictEqual(av.counts(),{opens:2,muxOpens:1,closed:2});
  assert.equal(writes.length,8);
  for(const index of [0,1]) {
    const pts=writes.filter(w=>w.index===index).map(w=>w.pts);
    assert(pts.every((value,i)=>i===0 || value>pts[i-1]));
  }
  assert.equal(writes[0].pts,0n,'nonzero input timestamps normalized');
  await p.close();
});

test('persistent NUT: abort releases a stalled output writer before native cleanup',async()=>{
  const writes=[];const av=fakeAv(writes,{write:true});
  const output=new PassThrough({highWaterMark:1});
  const p=new PersistentNut({output,loadAv:async()=>av});
  const appending=p.append(new PassThrough());
  await new Promise(resolve=>setImmediate(resolve));
  p.interrupt();
  await assert.rejects(appending,/Persistent output closed/);
  assert.equal(av.counts().closed,1);
  await p.close();
});

test('persistent NUT: overlapping content writers rejected',async()=>{
  const av=fakeAv([],{write:true});const p=new PersistentNut({output:new PassThrough({highWaterMark:1}),loadAv:async()=>av});
  const first=p.append(new PassThrough());
  await assert.rejects(p.append(new PassThrough()),/Concurrent NUT writers/);
  p.interrupt();await first.catch(() => {});await p.close();
  assert.equal(av.counts().closed,1);
});

test('persistent demux: disables opening-packet discard only on registered inputs',async()=>{
  const guard=require('../src/streambot/demuxGuard');const seen=[];
  class Fake {static async open(input,opts){seen.push(opts);return new Fake();} close(){}}
  guard.installDemuxerTracker(Fake);
  const input=new PassThrough();guard.registerPersistentInput(input);
  const a=await Fake.open(input,{format:'nut',options:{fflags:'nobuffer'}});
  const b=await Fake.open(new PassThrough(),{format:'nut',options:{fflags:'nobuffer'}});
  assert.equal(seen[0].skipStreamInfo,true);assert.equal(seen[0].options.fflags,'0');
  assert.equal(seen[1].skipStreamInfo,undefined);assert.equal(seen[1].options.fflags,'nobuffer');
  await a.close();await b.close();
});

test('persistent track feeder creates one go-live connection across sequential content', async () => {
  let creates = 0; let videoFrames = 0; let audioFrames = 0; let frees = 0;
  const guard = require('../src/streambot/demuxGuard');
  const demuxOptions = [];
  class FakeDemuxer {
    static async open(_input, options) { demuxOptions.push(options); return new FakeDemuxer(); }
    close() {}
  }
  guard.installDemuxerTracker(FakeDemuxer);
  const connection = {
    ready: true,
    setPacketizer(codec) { assert.equal(codec, 'H264'); },
    mediaConnection: { setSpeaking(value) { assert.equal(value, true); }, setVideoAttributes() {} },
    sendVideoFrame() { videoFrames++; }, sendAudioFrame() { audioFrames++; }
  };
  const packet = (pts, duration, den) => ({
    data: Buffer.from([1]), pts: BigInt(pts), duration: BigInt(duration),
    timeBase: { num: 1, den }, free() { frees++; }
  });
  const videoModule = { demux: async input => {
    const demuxer = await FakeDemuxer.open(input, { format: 'nut', options: { fflags: 'nobuffer' } });
    await demuxer.close();
    const video = new PassThrough({ objectMode: true });
    const audio = new PassThrough({ objectMode: true });
    queueMicrotask(() => { video.end(packet(0, 1, 30)); audio.end(packet(0, 960, 48000)); });
    return { video: { stream: video }, audio: { stream: audio } };
  } };
  const feeder = new PersistentTrackFeeder({
    streamer: { createStream: async () => { creates++; return connection; } }, videoModule
  });
  // This is the production startup shape: pipeline startup and the first
  // append race one another. They must share one createStream() handshake.
  let playedSec = 0;
  await Promise.all([
    feeder.start(),
    feeder.append(new PassThrough(), new AbortController().signal, ms => { playedSec += ms / 1000; })
  ]);
  await feeder.append(new PassThrough(), new AbortController().signal);
  assert.equal(creates, 1, 'content changes must not recreate the Discord stream');
  assert.equal(demuxOptions.length, 2);
  for (const options of demuxOptions) {
    assert.equal(options.skipStreamInfo, true, 'each new content input must preserve its opening packets');
    assert.equal(options.options.fflags, '0');
  }
  assert.equal(videoFrames, 2); assert.equal(audioFrames, 2); assert.equal(frees, 4);
  assert.equal(feeder.rtcBytesSent, 4, 'count payload only after WebRTC reports ready');
  assert.ok(playedSec > 0.03 && playedSec < 0.04, 'progress follows frames sent to WebRTC');
  await feeder.close();
});

test('persistent track feeder configures the negotiated AV1 packetizer', async () => {
  const codecs = [];
  const connection = {
    ready: true,
    setPacketizer(codec) { codecs.push(codec); },
    mediaConnection: { setSpeaking() {}, setVideoAttributes() {} }
  };
  const feeder = new PersistentTrackFeeder({
    streamer: { createStream: async () => connection }, videoModule: {}, videoCodec: 'AV1'
  });
  await feeder.start();
  assert.deepStrictEqual(codecs, ['AV1']);
});

test('VOD feeder drains a full video queue to reach the next audio packet', async () => {
  const packet = pts => ({
    data: Buffer.from([1]), pts: BigInt(pts), duration: 1n,
    timeBase: { num: 1, den: 1000 }, free() {}
  });
  let videoFrames = 0;
  let audioFrames = 0;
  const connection = {
    ready: true, setPacketizer() {},
    mediaConnection: { setSpeaking() {}, setVideoAttributes() {} },
    sendVideoFrame() { videoFrames++; },
    sendAudioFrame() { audioFrames++; }
  };
  const videoModule = { demux: async () => {
    // The installed demuxer stops its single read loop when either 128-packet
    // output queue fills. Put the next audio packet behind that much video.
    const video = new PassThrough({ objectMode: true, writableHighWaterMark: 128 });
    const audio = new PassThrough({ objectMode: true, writableHighWaterMark: 128 });
    const packets = [{ target: audio, pts: 0 },
      ...Array.from({ length: 130 }, (_, pts) => ({ target: video, pts })),
      { target: audio, pts: 130 }];
    let index = 0;
    const read = () => {
      while (index < packets.length) {
        const next = packets[index++];
        if (!next.target.write(packet(next.pts))) return;
      }
      video.end();
      audio.end();
    };
    video.on('drain', read);
    audio.on('drain', read);
    queueMicrotask(read);
    return { video: { stream: video }, audio: { stream: audio } };
  } };
  const feeder = new PersistentTrackFeeder({
    streamer: { createStream: async () => connection }, videoModule
  });
  try {
    await feeder.append(new PassThrough(), new AbortController().signal, undefined,
      { syncVideoToAudio: false });
    assert.equal(videoFrames, 130);
    assert.equal(audioFrames, 2);
  } finally {
    await feeder.close();
  }
});

test('timed track rebases after starvation instead of bursting delayed frames', async () => {
  const times = [0, 0, 1000, 1000];
  const sleeps = [];
  const track = new TimedTrack(() => {}, 'video', {
    now: () => times.shift(),
    sleep: async ms => { sleeps.push(ms); },
    maxCatchupMs: 250
  });
  const packet = pts => ({
    data: Buffer.from([1]), pts: BigInt(pts), duration: 1n,
    timeBase: { num: 1, den: 30 }, free() {}
  });
  await new Promise((resolve, reject) => track.write(packet(0), error => error ? reject(error) : resolve()));
  await new Promise((resolve, reject) => track.write(packet(1), error => error ? reject(error) : resolve()));
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[0] > 30 && sleeps[0] < 35, 'normal first frame uses 30fps pacing');
  assert.ok(sleeps[1] > 30 && sleeps[1] < 35, 'late frame resumes 30fps pacing instead of a zero-delay burst');
  track.destroy();
});

test('timed tracks advance RTP time when an encoder omits packet duration', async () => {
  for (const [type, expectedMs] of [['video', 1000 / 30], ['audio', 20]]) {
    const sent = [];
    const track = new TimedTrack((_data, frameMs) => sent.push(frameMs), type, {
      now: () => 0, sleep: async () => {}, defaultDurationMs: expectedMs
    });
    const packet = { data: Buffer.from([1]), pts: 0n, duration: 0n,
      timeBase: { num: 1, den: 1000 }, free() {} };
    await new Promise((resolve, reject) => track.write(packet, error => error ? reject(error) : resolve()));
    assert.deepEqual(sent, [expectedMs]);
    track.destroy();
  }
});

test('timed track rebases a live timestamp discontinuity instead of sleeping for the jump', async () => {
  const times = [0, 0, 34, 34];
  const sleeps = [];
  const track = new TimedTrack(() => {}, 'video', {
    now: () => times.shift(),
    sleep: async ms => { sleeps.push(ms); },
    maxPtsJumpMs: 500
  });
  const packet = pts => ({
    data: Buffer.from([1]), pts: BigInt(pts), duration: 1n,
    timeBase: { num: 1, den: 30 }, free() {}
  });
  await new Promise((resolve, reject) => track.write(packet(0), error => error ? reject(error) : resolve()));
  // Jump from frame 0 to media second 3. This used to schedule roughly a
  // three-second sleep; it must resume at one normal frame interval.
  await new Promise((resolve, reject) => track.write(packet(90), error => error ? reject(error) : resolve()));
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[1] > 30 && sleeps[1] < 35, `expected one frame sleep, got ${sleeps[1]}ms`);
  track.destroy();
});

test('video pacing fails a stalled audio clock before sending unsynced frames', async () => {
  const { TimedTrack } = require('../src/streambot/persistentTrackFeeder');
  const sleeps = [];
  let sent = 0;
  const track = new TimedTrack(() => { sent++; }, 'video', {
    now: () => 0,
    sleep: async ms => { sleeps.push(ms); },
    maxSyncWaitMs: 100
  });
  track.on('error', () => {});
  track.syncTrack = { pts: 0, writableEnded: false };
  const packet = pts => ({
    data: Buffer.from([1]), pts: BigInt(pts), duration: 1n,
    timeBase: { num: 1, den: 30 }, free() {}
  });
  await assert.rejects(
    new Promise((resolve, reject) => track.write(packet(30), error => error ? reject(error) : resolve())),
    error => error?.code === 'AV_SYNC_LOST'
  );
  const firstWait = sleeps.reduce((sum, ms) => sum + ms, 0);
  assert.equal(firstWait, 100);
  assert.equal(sent, 0, 'do not send video while audio is behind');
  track.destroy();
});

test('track diagnostics expose video stalls without changing scheduling or retaining packets', async () => {
  const runs = [];
  for (const diagnostics of [false, true]) {
    let now = 0; let frees = 0;
    const sleeps = []; const sends = [];
    const track = new TimedTrack((_data, ms) => { sends.push([now, ms]); }, 'video', {
      diagnostics, now: () => now,
      sleep: async ms => { sleeps.push(ms); now += ms; }
    });
    for (let i = 0; i < 3; i++) {
      if (i === 2) now += 1000;
      const packet = { data: Buffer.from([1, 2]), pts: BigInt(i), duration: 1n,
        timeBase: { num: 1, den: 30 }, isKeyframe: i === 0, free() { frees++; } };
      await new Promise((resolve, reject) => track.write(packet, e => e ? reject(e) : resolve()));
    }
    assert.equal(frees, 3);
    const stats = track.takeDiagnostics();
    if (diagnostics) {
      assert.equal(stats.frames, 3);
      assert.equal(stats.bytes, 6);
      assert.equal(stats.resets, 1);
      assert.ok(stats.maxGapMs > 1000);
      assert.ok(stats.keyAgeMs > 1000);
      now += 500;
      const next = track.takeDiagnostics();
      assert.equal(next.frames, 0);
      assert.equal(next.bytes, 0);
      assert.equal(next.resets, 0);
      assert.ok(next.ageMs >= 500, 'ongoing stalls remain visible even without new frames');
      assert.ok(Object.values(track.diagnostics).every(v => v === null || typeof v === 'number'));
    } else assert.equal(stats, null);
    runs.push({ sends, sleeps });
    track.destroy();
  }
  assert.deepEqual(runs[0], runs[1], 'diagnostics must not alter send timing or sleeps');
});

test('track diagnostics do not count frames rejected by an unready connection', async () => {
  const track = new TimedTrack(() => false, 'video', { diagnostics: true, now: () => 0, sleep: async () => {} });
  await new Promise((resolve, reject) => track.write({
    data: Buffer.from([1]), pts: 0n, duration: 1n, timeBase: { num: 1, den: 30 }, isKeyframe: true, free() {}
  }, e => e ? reject(e) : resolve()));
  const stats = track.takeDiagnostics();
  assert.equal(stats.frames, 0);
  assert.equal(stats.keyAgeMs, null);
  track.destroy();
});
