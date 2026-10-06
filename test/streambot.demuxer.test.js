'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

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
const { configureVideoTransport, createReceiverReports } = require('../src/streambot/videoTransport');

test('video transport observes the upstream video chain without replacing it', () => {
  const rtc = require('@lng2004/node-datachannel');
  for (const codec of ['H264', 'H265', 'AV1']) {
    const config = new rtc.RtpPacketizationConfig(42, 'test', 101, 90000);
    config.timestamp = 9000;
    config.playoutDelayId = 5;
    config.playoutDelayMax = 10;
    const packetizer = { rtpConfig: config };
    let installed = false;
    const audio = {};
    const connection = { _videoPacketizer: packetizer, _audioPacketizer: audio,
      _videoTrack: { setMediaHandler() { installed = true; } } };
    const transport = configureVideoTransport(connection);
    assert.equal(transport.pacingBps, null);
    connection._videoPacingBps = 6000000;
    assert.equal(transport.takeDiagnostics().pacingKbps, 6000);
    connection._videoPacingBps = 8000000;
    assert.equal(transport.takeDiagnostics().pacingKbps, 8000);
    assert.equal(connection._videoPacketizer, packetizer);
    assert.equal(installed, false);
    assert.equal(packetizer.rtpConfig.timestamp, 9000);
    assert.equal(packetizer.rtpConfig.playoutDelayMax, 10);
    assert.equal(connection._audioPacketizer, audio);
  }
});

test('receiver diagnostics read matching RTCP reports without retaining or mutating buffers', () => {
  let now = 100;
  const reports = createReceiverReports(42, () => now);
  assert.equal(reports.snapshot().lossPct, null, 'no feedback is unknown, not zero loss');
  const rr = Buffer.alloc(32);
  rr[0] = 0x81; rr[1] = 201; rr.writeUInt16BE(7, 2);
  rr.writeUInt32BE(42, 8); rr[12] = 8;
  rr.writeIntBE(3, 13, 3); rr.writeUInt32BE(900, 20);
  const pli = Buffer.alloc(12);
  pli[0] = 0x81; pli[1] = 206; pli.writeUInt16BE(2, 2); pli.writeUInt32BE(42, 8);
  const compound = Buffer.concat([rr, pli]);
  const original = Buffer.from(compound);
  reports.consume(compound);
  now = 200;
  assert.deepEqual(reports.snapshot(), { reportAgeMs: 100, lossPct: 3.125, lostTotal: 3, jitterMs: 10, pli: 1 });
  assert.equal(reports.snapshot().pli, 0);
  assert.deepEqual(compound, original);
  rr.writeUInt32BE(43, 8); rr[12] = 255;
  reports.consume(rr);
  for (let size = 0; size < 32; size++) reports.consume(rr.subarray(0, size));
  assert.equal(reports.snapshot().lossPct, 3.125, 'ignore other SSRCs and truncated packets');
});
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

test('Music Mode sends Opus through voice while video stays on Go Live', async () => {
  const { PassThrough } = require('node:stream');
  const { PersistentTrackFeeder } = require('../src/streambot/persistentTrackFeeder');
  const sent = { goLiveVideo: 0, goLiveAudio: 0, voiceAudio: 0, voicePacketizers: 0, speaking: [] };
  const goLive = { ready: true, setPacketizer() {},
    mediaConnection: { setSpeaking() {}, setVideoAttributes() {} },
    sendVideoFrame() { sent.goLiveVideo++; }, sendAudioFrame() { sent.goLiveAudio++; } };
  const voice = { ready: true, setPacketizer() { sent.voicePacketizers++; },
    mediaConnection: { setSpeaking(value) { sent.speaking.push(value); } },
    sendAudioFrame() { sent.voiceAudio++; } };
  const packet = (pts, duration, den) => ({ data: Buffer.from([1]), pts: BigInt(pts),
    duration: BigInt(duration), timeBase: { num: 1, den }, free() {} });
  const videoModule = { demux: async () => {
    const video = new PassThrough({ objectMode: true });
    const audio = new PassThrough({ objectMode: true });
    queueMicrotask(() => { video.end(packet(0, 1, 30)); audio.end(packet(0, 960, 48000)); });
    return { video: { stream: video }, audio: { stream: audio } };
  } };
  const feeder = new PersistentTrackFeeder({
    streamer: { createStream: async () => goLive, voiceConnection: { webRtcConn: voice } }, videoModule
  });
  await feeder.append(new PassThrough(), new AbortController().signal, null, { voiceAudio: true });
  assert.equal(sent.goLiveVideo, 1);
  assert.equal(sent.goLiveAudio, 0);
  assert.equal(sent.voiceAudio, 1);
  assert.equal(sent.voicePacketizers, 1);
  assert.deepEqual(sent.speaking, [true, false]);
  await feeder.close();
});

test('persistent track feeder configures the requested H.265 and AV1 packetizers', async () => {
  const codecs = [];
  for (const videoCodec of ['H265', 'AV1']) {
    const connection = {
      ready: true,
      setPacketizer(codec) { codecs.push(codec); },
      mediaConnection: { setSpeaking() {}, setVideoAttributes() {} }
    };
    const feeder = new PersistentTrackFeeder({
      streamer: { createStream: async () => connection }, videoModule: {}, videoCodec
    });
    await feeder.start();
  }
  assert.deepStrictEqual(codecs, ['H265', 'AV1']);
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

test('live video keeps frame spacing after waiting for delayed audio', async () => {
  let now = 0;
  const sentAt = [];
  const audio = { pts: 0, writableEnded: false };
  const track = new TimedTrack(() => sentAt.push(now), 'video', {
    now: () => now,
    sleep: async ms => {
      now += ms;
      // One brief audio delivery delay, then the normal 20ms audio clock.
      audio.pts = now < 50 ? 0 : Math.floor(now / 20) * 20;
    }
  });
  try {
    track.syncTrack = audio;
    for (let pts = 0; pts < 30; pts++) {
      const packet = { data: Buffer.from([1]), pts: BigInt(pts), duration: 1n,
        timeBase: { num: 1, den: 30 }, free() {} };
      await new Promise((resolve, reject) => track.write(packet, error => error ? reject(error) : resolve()));
    }
    const gaps = sentAt.slice(1).map((time, i) => time - sentAt[i]);
    assert.ok(Math.min(...gaps) >= 32, `video frames bunched after audio wait: ${gaps}`);
    assert.ok(sentAt.at(-1) < 1050, 'a brief audio delay must not accumulate into growing playback lag');
  } finally { track.destroy(); }
});

test('live video does not pause for one ordinary frame of audio lead', async () => {
  let now = 0;
  const sentAt = [];
  const sleeps = [];
  const track = new TimedTrack(() => sentAt.push(now), 'video', {
    now: () => now, diagnostics: true,
    sleep: async ms => { sleeps.push(ms); now += ms; }
  });
  track.syncTrack = { pts: 0, writableEnded: false };
  try {
    await new Promise((resolve, reject) => track.write({
      data: Buffer.from([1]), pts: 40n, duration: 33n,
      timeBase: { num: 1, den: 1000 }, free() {}
    }, error => error ? reject(error) : resolve()));
    assert.deepEqual(sentAt, [0]);
    assert.deepEqual(sleeps, [33]);
    assert.equal(track.takeDiagnostics().syncWaitMs, 0);
  } finally { track.destroy(); }
});

test('video pacing fails a stalled audio clock before sending unsynced frames', async () => {
  const { TimedTrack } = require('../src/streambot/persistentTrackFeeder');
  const sleeps = [];
  let sent = 0;
  let now = 0;
  const track = new TimedTrack(() => { sent++; }, 'video', {
    now: () => now, diagnostics: true,
    sleep: async ms => { sleeps.push(ms); now += ms; },
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
  assert.equal(track.takeDiagnostics().syncWaitMs, 100, 'failed sync waits must remain visible in metrics');
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
      assert.equal(stats.lateResets, 1);
      assert.equal(stats.timestampResets, 0);
      assert.ok(stats.lateMaxMs > 250);
      assert.ok(stats.maxGapMs > 1000);
      assert.ok(stats.keyAgeMs > 1000);
      now += 500;
      const next = track.takeDiagnostics();
      assert.equal(next.frames, 0);
      assert.equal(next.bytes, 0);
      assert.equal(next.resets, 0);
      assert.equal(next.lateResets, 0);
      assert.equal(next.sendCallMaxMs, 0);
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
  assert.equal(stats.rejectedFrames, 1);
  assert.equal(stats.keyAgeMs, null);
  track.destroy();
});

test('patched transport adapts pacing to source bitrate and never retries queued sends', async () => {
  const { pathToFileURL } = require('node:url');
  const root = path.dirname(require.resolve('@dank074/discord-video-stream'));
  const { WebRtcConnWrapper } = await import(pathToFileURL(path.join(root, 'client/voice/WebRtcWrapper.js')));
  const conn = new WebRtcConnWrapper({ webRtcParams: { audioSsrc: 41, videoSsrc: 42, rtxSsrc: 43 }, daveReady: false });
  conn.setPacketizer('H265');
  conn._videoPacketizer.rtpConfig.timestamp = 0;
  assert.equal(conn._videoPacingBps, 10000000);
  assert.equal(typeof conn._videoPacer.setBitrate, 'function');
  conn._webRtcConn = { state: () => 'connected' };
  let sends = 0;
  conn._videoTrack = { sendMessageBinary() { sends++; return false; } };
  const clock = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    const frame = Buffer.alloc(10000);
    conn.sendVideoFrame(frame, 1000 / 30);
    assert.equal(conn._videoPacingBps, 1000000);
    for (let i = 0; i < 7; i++) { now += 30; conn.sendVideoFrame(frame, 1000 / 30); }
    assert.equal(conn._videoPacingBps, 3200000);
    now += 1000;
    conn.sendVideoFrame(frame, 1000 / 30);
    assert.equal(conn._videoPacingBps, 1000000);
    assert.equal(sends, 9);
    assert.equal(conn._videoPacketizer.rtpConfig.timestamp, 27000);
    assert.equal(conn._bitrateCalculator._samples.length, 1);
  } finally { Date.now = clock; }
});

test('Music Mode negotiated voice transport delivers Opus RTP after packetizer setup', () => {
  const { execFileSync } = require('node:child_process');
  const result = execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/validate-native-audio.cjs')],
    { encoding: 'utf8', timeout: 10000 });
  assert.match(result, /3 Opus RTP packets delivered/);
});

test('transport install patch upgrades old installs, patches fresh installs, and rejects drift before writing', () => {
  const { patchDiscordTransport } = require('../scripts/patch-discord-transport');
  const installed = path.resolve(path.dirname(require.resolve('@dank074/discord-video-stream')), '..');
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'transport-patch-'));
  try {
    fs.mkdirSync(path.join(fixture, 'dist/client/voice'), { recursive: true });
    fs.writeFileSync(path.join(fixture, 'package.json'), '{"version":"6.0.0"}');
    const target = path.join(fixture, 'dist/client/voice/WebRtcWrapper.js');
    const patched = fs.readFileSync(path.join(installed, 'dist/client/voice/WebRtcWrapper.js'), 'utf8');
    fs.writeFileSync(target, patched);
    assert.equal(patchDiscordTransport(fixture), false);
    assert.equal(fs.readFileSync(target, 'utf8'), patched);
    const audioRegistration = '        if (!this._audioDef.hasSSRC(audioSsrc)) this._audioDef.addSSRC(audioSsrc);\n';
    assert.ok(patched.includes(audioRegistration));
    const previous = patched.replace(audioRegistration, '').replace(
      'const { audioSsrc, videoSsrc, rtxSsrc } = this.mediaConnection.webRtcParams;',
      'const { videoSsrc, rtxSsrc } = this.mediaConnection.webRtcParams;');
    fs.writeFileSync(target, previous);
    assert.equal(patchDiscordTransport(fixture), true);
    assert.equal(fs.readFileSync(target, 'utf8'), patched);
    const fresh = previous.replace(/    initWebRtc\(\) \{\n        const \{ videoSsrc, rtxSsrc \} = this.mediaConnection.webRtcParams;\n        if \(!this._videoDef.hasSSRC\(videoSsrc\)\) this._videoDef.addSSRC\(videoSsrc\);\n        this._videoDef.addRtxSSRC\(videoSsrc, rtxSsrc\);/, '    initWebRtc() {');
    fs.writeFileSync(target, fresh);
    assert.equal(patchDiscordTransport(fixture), true);
    assert.equal(fs.readFileSync(target, 'utf8'), patched);
    fs.writeFileSync(path.join(fixture, 'package.json'), '{"version":"7.0.0"}');
    assert.throws(() => patchDiscordTransport(fixture), /requires discord-video-stream 6.0.0/);
    fs.writeFileSync(path.join(fixture, 'package.json'), '{"version":"6.0.0"}');
    fs.writeFileSync(target, 'unexpected upstream content');
    assert.throws(() => patchDiscordTransport(fixture), /expected one anchor/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'unexpected upstream content');
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
});
