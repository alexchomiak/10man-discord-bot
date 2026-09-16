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
const { PersistentTrackFeeder } = require('../src/streambot/persistentTrackFeeder');
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
  const connection = {
    setPacketizer(codec) { assert.equal(codec, 'H264'); },
    mediaConnection: { setSpeaking(value) { assert.equal(value, true); }, setVideoAttributes() {} },
    sendVideoFrame() { videoFrames++; }, sendAudioFrame() { audioFrames++; }
  };
  const packet = (pts, duration, den) => ({
    data: Buffer.from([1]), pts: BigInt(pts), duration: BigInt(duration),
    timeBase: { num: 1, den }, free() { frees++; }
  });
  const videoModule = { demux: async () => {
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
  await Promise.all([
    feeder.start(),
    feeder.append(new PassThrough(), new AbortController().signal)
  ]);
  await feeder.append(new PassThrough(), new AbortController().signal);
  assert.equal(creates, 1, 'content changes must not recreate the Discord stream');
  assert.equal(videoFrames, 2); assert.equal(audioFrames, 2); assert.equal(frees, 4);
  await feeder.close();
});
