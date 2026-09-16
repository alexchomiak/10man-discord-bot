'use strict';

const { test } = require('node:test');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const assert = require('node:assert');

const { StreamManager } = require('../src/streambot/streamManager');
const { CommandRegistry } = require('../src/streambot/commands');
const { trackedDemuxers } = require('../src/streambot/demuxGuard');
const { createAlertSink } = require('../src/streambot/alerts');
const { M } = require('../src/streambot/messages');
const { parseSignedDuration } = require('../src/streambot/sources');

// ============================================================================
// fake Streamer / videoModule factory: a Streamer with controllable
// voiceConnection lifetime, spied joinVoice/leaveVoice/stopStream/signalVideo.
// ============================================================================
function makeStreamerInstance() {
  const calls = { joinVoice: 0, leaveVoice: 0, stopStream: 0, signalVideo: [] };
  const s = {
    calls,
    createStreamCalls: 0,
    voiceConnection: null,
    joinVoice: async (g, c) => {
      calls.joinVoice += 1;
      // Mirror the real library's persistent-voice path: on a live voice WS
      // voiceConnection.webRtcConn is the WebRTC connection the camera-type
      // playStream REUSES directly (newApi.js:303). streamConnection is the
      // go-live (per-stream) concept and stays absent in camera mode.
      s.voiceConnection = {
        streamConnection: null,
        webRtcConn: { state: () => 'connected' },
        guildId: g, channelId: c, botId: 'u1'
      };
      return { mediaConnection: { webRtcParams: null, start() {} } };
    },
    createStream: async () => {
      s.createStreamCalls += 1;
      if (!s.voiceConnection) s.voiceConnection = { streamConnection: null };
      s.voiceConnection.streamConnection = { serverId: 'srv', webRtcConn: { ready: true } };
      return s.voiceConnection.streamConnection;
    },
    // Mirror the real lib (Streamer.js:134-140): `voiceConnection?.stop()`
    // is null-guarded (no-op when there is no active session) and
    // `signalLeaveVoice()` broadcasts a null-channel VOICE_STATE_UPDATE.
    // Count only "teardown of an active session" — a pre-join null-state
    // reset against an already-absent connection is a semantic no-op in the
    // fake's in-memory model and is NOT incremented (matching the real lib's
    // null-guarded stop()). The wire op still goes out for the real lib, but
    // the fake has no wire to observe, so the counter tracks real work.
    leaveVoice: () => {
      if (s.voiceConnection) {
        calls.leaveVoice += 1;
        s.voiceConnection = undefined;
      }
    },
    stopStream: () => {
      calls.stopStream += 1;
      // Mirror Streamer.js:124-133 — stopStream resets the streamConnection.
      if (s.voiceConnection) s.voiceConnection.streamConnection = undefined;
    },
    // Mirror Streamer.js:141-152: camera-mode teardown is a
    // VOICE_STATE_UPDATE { self_video: false } on the live voice WS.
    signalVideo: (v) => { calls.signalVideo.push(v); }
  };
  return s;
}

function makeStreamerBase() {
  const calls = { joinVoice: 0, leaveVoice: 0, stopStream: 0, signalVideo: [] };
  const s = {
    calls,
    createStreamCalls: 0,
    voiceConnection: null,
    joinVoice: async (g, c) => {
      calls.joinVoice += 1;
      // Mirror the real library's persistent-voice path: on a live voice WS
      // voiceConnection.webRtcConn is the WebRTC connection the camera-type
      // playStream REUSES directly (newApi.js:303). streamConnection is the
      // go-live (per-stream) concept and stays absent in camera mode.
      s.voiceConnection = {
        streamConnection: null,
        webRtcConn: { state: () => 'connected' },
        guildId: g, channelId: c, botId: 'u1'
      };
      return { mediaConnection: { webRtcParams: null, start() {} } };
    },
    createStream: async () => {
      s.createStreamCalls += 1;
      if (!s.voiceConnection) s.voiceConnection = { streamConnection: null };
      s.voiceConnection.streamConnection = { serverId: 'srv', webRtcConn: { ready: true } };
      return s.voiceConnection.streamConnection;
    },
    // Mirror the real lib (Streamer.js:134-140): count only "teardown of an
    // active session" (voiceConnection present); a pre-join null-state reset
    // against an already-absent connection is a semantic no-op in the fake's
    // in-memory model and is NOT incremented (matching the real lib's
    // null-guarded `voiceConnection?.stop()`).
    leaveVoice: () => {
      if (s.voiceConnection) {
        calls.leaveVoice += 1;
        s.voiceConnection = undefined;
      }
    },
    stopStream: () => {
      calls.stopStream += 1;
      // Mirror Streamer.js:124-133 — stopStream resets the streamConnection.
      if (s.voiceConnection) s.voiceConnection.streamConnection = undefined;
    },
    // Mirror Streamer.js:141-152: camera-mode teardown is a
    // VOICE_STATE_UPDATE { self_video: false } on the live voice WS.
    signalVideo: (v) => { calls.signalVideo.push(v); }
  };
  return { s, calls };
}

function fakeVideoModule(opts = {}) {
  let streamer = null;
  let calls;
  if (opts.streamerFactory) {
    streamer = opts.streamerFactory();
    calls = streamer.calls;
  } else {
    const b = makeStreamerBase();
    streamer = b.s;
    calls = b.calls;
  }
  const plays = [];
  const pieces = [];
  const collected = [];
  const moduleRef = {
    Streamer: function () {
      return streamer;
    },
    prepareStream: (url, options, signal) => {
      const command = new EventEmitter();
      const output = new PassThrough();
      const promise = new Promise((resolve, reject) => {
        command.on('end', resolve);
        command.on('error', reject);
      });
      promise.catch(() => {});
      command.kill = sig => { command.killed = sig; output.end(); command.emit('error', new Error('cancelled')); };
      command.getCommand = () => ['ffmpeg', '-i', url];
      const piece = { url, options, signal, command, output, promise,
        write: value => output.write(value),
        end: () => { output.end(); command.emit('end'); },
        fail: () => { output.destroy(); command.emit('error', new Error('encoder failed')); } };
      pieces.push(piece);
      return piece;
    },
    playStream: (input, str, options, signal) => new Promise((resolve, reject) => {
      if (!str.voiceConnection) { reject(new Error('not joined')); return; }
      if (!opts.hang) str.createStream().catch(reject);
      input.on('data', chunk => collected.push(chunk.toString()));
      signal.addEventListener('abort', () => { str.stopStream(); resolve(); }, {once:true});
      plays.push({ resolve, reject, options, input });
    }),
    Utils: { normalizeVideoCodec: (c) => c }
  };
  return { moduleRef, get streamer() { return streamer; }, plays, calls, pieces, collected };
}

function makeMessage({ replyTexts, channelId = 'c1', guildId = 'g1' } = {}) {
  replyTexts = replyTexts || [];
  const message = {
    guild: { id: guildId },
    member: { voice: { channelId } },
    reply: async (t) => { replyTexts.push(t); },
    channel: { id: channelId, send: async (t) => { replyTexts.push(t); } }
  };
  return { message, replyTexts };
}

function makeClient(channels) {
  channels = channels || { c1: { id: 'c1', send: async () => {} } };
  return {
    token: 'test-token',
    user: { id: 'u1' },
    channels: {
      cache: { get: (id) => (id in channels ? channels[id] : null) },
      // Mirror the real client: an unknown id RESOLVES to that id (it is
      // fetchable) rather than to null — tests that drive a second channel
      // (c2) rely on this.
      fetch: async (id) => channels[id] || { id }
    }
  };
}


const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
  for (let n = 0; n < 100; n++) { if (check()) return; await new Promise(r => setTimeout(r, 2)); }
  assert.fail('condition did not settle');
}
function fixture(t, config = {}, moduleOptions = {}) {
  const fv = fakeVideoModule(moduleOptions);
  const alerts = [];
  const mgr = new StreamManager(makeClient(), 'c1', { playStreamStartTimeoutMs: 100,
    alertSink: { notify: async (event, detail) => alerts.push({event,detail}) }, ...config });
  mgr._videoModule = fv.moduleRef;
  mgr._prepareSingle = (vm, piece) => vm.prepareStream(piece.streamUrl,
    mgr.setupStreamOptions(vm, piece.startOffsetSec, piece.durationSec, piece.inputFormat), piece.control.signal);
  let writers = 0;
  let maxWriters = 0;
  let closeCount = 0;
  mgr._feederFactory = streamer => ({
    start: async () => {
      const play = {};
      fv.plays.push(play);
      if (moduleOptions.hang) return new Promise(() => {});
      if (moduleOptions.failStart) throw new Error('persistent feeder failed');
      play.connection = await streamer.createStream();
      return play.connection;
    },
    append: async (input, signal) => {
      writers++; maxWriters = Math.max(maxWriters, writers);
      if (moduleOptions.hangAppend) return new Promise(() => {});
      const cancel = () => input.destroy();
      signal.addEventListener('abort', cancel, {once:true});
      try { for await (const chunk of input) { if (!signal.aborted) fv.collected.push(chunk.toString()); } }
      catch (error) { if (!signal.aborted) throw error; }
      finally { writers--; signal.removeEventListener('abort', cancel); }
    },
    interrupt: () => {},
    close: async () => { closeCount++; }
  });
  t.after(() => mgr.stop());
  const start = name => mgr.start({guildId:'g1',channelId:'c1',streamUrl:`https://example.com/${name}.mp4`,title:name});
  return {mgr,fv,start,alerts,get maxWriters(){return maxWriters;}, get closeCount(){return closeCount;}};
}

test('config: grace, filler and queue defaults retain existing env names', () => {
  const old = process.env.SELF_BOT_TOKEN;
  process.env.SELF_BOT_TOKEN = 'test';
  try {
    const cfg = require('../src/streambot/config').loadConfig();
    assert.equal(cfg.streamGraceMs, Number(process.env.STREAM_GRACE_MS) || 300000);
    assert.equal(cfg.streamQueueLimit, Number(process.env.STREAM_QUEUE_LIMIT) || 20);
  } finally { if (old === undefined) delete process.env.SELF_BOT_TOKEN; else process.env.SELF_BOT_TOKEN=old; }
});

test('one go-live call and strict shared-output order across N queued pieces', async t => {
  const f=fixture(t,{streamBufferSec:0}); const {mgr,fv,start}=f;
  const first=await start('a');
  const second=await start('b'); const third=await start('c');
  assert(first.ok && second.ok && third.ok);
  assert.equal(second.queued,true);
  assert.equal(fv.pieces.length,1,'queued encoders have not started');
  fv.pieces[0].write('A'); fv.pieces[0].end();
  await until(()=>fv.pieces.length===2);
  fv.pieces[1].write('B'); fv.pieces[1].end();
  await until(()=>fv.pieces.length===3);
  fv.pieces[2].write('C'); fv.pieces[2].end();
  await until(()=>mgr.session===null);
  assert.equal(fv.collected.join(''),'ABC');
  assert.equal(f.maxWriters,1);
  assert.equal(fv.plays.length,1);
  assert.equal(fv.streamer.createStreamCalls,1);
  assert.equal(fv.calls.stopStream,0);
  assert.deepEqual(fv.calls.signalVideo, []);
  assert(!first.pipeline.closed,'idle keeps the persistent stream open');
  await mgr.stop();
  assert.equal(fv.calls.stopStream,1);
  assert.deepEqual(fv.calls.signalVideo,[]);
  assert.equal(f.closeCount,1);
});

test('placeholder is content[0]; replacement never closes shared demuxers or track', async t => {
  const {mgr,fv,start}=fixture(t);
  const r=await mgr.ensureChannel('g1','c1'); assert(r.fillerStarted);
  const p=mgr.voiceLink.pipeline;
  const orphan={close:async()=>{orphan.count++;},count:0}; trackedDemuxers.add(orphan);
  assert.match(fv.pieces[0].url,/testsrc/);
  assert(fv.pieces[0].options.customInputOptions.includes('lavfi'));
  fv.pieces[0].write('placeholder'); await tick();
  await start('real'); await until(()=>fv.pieces.length===2);
  fv.pieces[1].write('real'); await tick();
  assert.equal(fv.collected.join(''),'placeholderreal');
  assert.equal(mgr.voiceLink.pipeline,p);
  assert.equal(fv.pieces[0].command.killed,'SIGTERM');
  assert.equal(orphan.count,0);
  assert.equal(fv.plays.length,1);
  assert.equal(fv.calls.stopStream,0);
  assert.deepEqual(fv.calls.signalVideo, []);
  await mgr.stop(); await mgr.stop();
  assert.equal(orphan.count,1,'global cleanup only once on final teardown');
});

test('$join is idempotent and never replaces real content', async t => {
  const {mgr,fv,start}=fixture(t);
  await mgr.ensureChannel('g1','c1');
  const initial=mgr.session;
  const r=await mgr.ensureChannel('g1','c1');
  assert(r.reused); assert(!r.fillerStarted); assert.equal(mgr.session,initial);
  await start('real'); await until(()=>fv.pieces.length===2);
  const real=mgr.session;
  await mgr.ensureChannel('g1','c1');
  assert.equal(mgr.session,real); assert.equal(fv.pieces.length,2);
  assert.equal(fv.calls.joinVoice,1);
});

test('filler disabled retains voice-only join until first stream', async t => {
  const {mgr,fv,start}=fixture(t,{fillerOnJoin:false});
  const r=await mgr.ensureChannel('g1','c1');
  assert(r.ok); assert(!r.fillerStarted); assert.equal(mgr.session,null);
  assert.equal(fv.plays.length,0);
  await start('a'); assert.equal(fv.plays.length,1);
});

test('placeholder duration ends only the piece and starts grace; session stays alive', async t => {
  const {mgr,fv}=fixture(t,{fillerDurationSec:12});
  await mgr.ensureChannel('g1','c1');
  assert(fv.pieces[0].options.customInputOptions.includes('12'));
  fv.pieces[0].end(); await until(()=>mgr.voiceLink.graceTimer);
  assert.equal(fv.calls.stopStream,0); assert.equal(fv.calls.leaveVoice,0);
  assert(!mgr.voiceLink.pipeline.closed);
});

test('grace expiration closes persistent session and leaves once', async t => {
  const {mgr,fv,start}=fixture(t);
  let fire; mgr._timerFactory = () => ({then: fn=>{fire=fn;},clear(){}});
  await start('a'); fv.pieces[0].end(); await until(()=>fire);
  await fire();
  assert.equal(mgr.voiceLink,null); assert.equal(fv.calls.leaveVoice,1);
  assert.equal(fv.calls.stopStream,1);
});

test('new content cancels grace and reuses original stream', async t => {
  const {mgr,fv,start}=fixture(t);
  let fire; let cleared=0;
  mgr._timerFactory=()=>({then:fn=>{fire=fn;},clear(){cleared++;}});
  await start('a'); const p=mgr.voiceLink.pipeline;
  fv.pieces[0].end(); await until(()=>fire);
  await start('b'); assert(cleared>0); await fire();
  assert.equal(mgr.voiceLink.pipeline,p); assert.equal(fv.calls.leaveVoice,0);
  assert.equal(fv.plays.length,1);
});

test('real grace timer is unrefed', async t => {
  const {mgr,fv,start}=fixture(t); await start('a');fv.pieces[0].end();
  await until(()=>mgr.voiceLink.graceTimer);
  assert.equal(mgr.voiceLink.graceTimer.hasRef(),false);
});

test('channel switch tears down old session before joining another', async t => {
  const {mgr,fv,start}=fixture(t);await start('a');const p=mgr.voiceLink.pipeline;
  await mgr.start({guildId:'g1',channelId:'c2',streamUrl:'https://example.com/b.mp4'});
  assert(p.closed);assert.equal(fv.calls.leaveVoice,1);assert.equal(fv.calls.joinVoice,2);
  assert.equal(fv.plays.length,2);assert.equal(mgr.voiceLink.channelId,'c2');
});

test('external Discord voice move reopens Go Live and preserves active content plus queue', async t => {
  const {mgr,fv,start}=fixture(t,{streamBufferSec:0});
  await start('a');
  await start('b');
  const oldPipeline=mgr.voiceLink.pipeline;
  mgr.session.startedAt=Date.now()-12_000;

  const result=await mgr.handleVoiceStateUpdate({
    t:'VOICE_STATE_UPDATE',
    d:{user_id:'u1',guild_id:'g1',channel_id:'c2'}
  });

  assert(result.ok && result.moved);
  assert(oldPipeline.closed,'the stream bound to the old call must be closed');
  assert.equal(mgr.voiceLink.channelId,'c2');
  assert.equal(fv.calls.joinVoice,2);
  assert.equal(fv.streamer.createStreamCalls,2,'Go Live must reopen in the destination call');
  assert.equal(fv.calls.leaveVoice,1);
  assert.equal(fv.calls.stopStream,1);
  assert.equal(mgr.session.title,'a');
  assert(mgr.session.startOffsetSec>=11,'seekable content resumes near its previous position');
  assert.deepEqual(mgr.voiceLink.pipeline.enqueue.map(piece=>piece.title),['b']);
});

test('external move cannot wedge stop/play commands when the old media writer never exits', async t => {
  const {mgr,start}=fixture(t,{streamBufferSec:0,streamCleanupTimeoutMs:30},{hangAppend:true});
  await start('a');

  const moved=await mgr.handleVoiceStateUpdate({
    t:'VOICE_STATE_UPDATE',
    d:{user_id:'u1',guild_id:'g1',channel_id:'c2'}
  });
  assert(moved.ok && moved.moved);
  assert.equal(mgr.voiceLink.channelId,'c2');

  await mgr.stop();
  assert.equal(mgr.voiceLink,null,'stop must run after forced cleanup instead of waiting forever');
});

test('unrelated and duplicate self voice-state updates do not reopen Go Live', async t => {
  const {mgr,fv,start}=fixture(t,{streamBufferSec:0});
  await start('a');
  await mgr.handleVoiceStateUpdate({t:'VOICE_STATE_UPDATE',d:{user_id:'other',guild_id:'g1',channel_id:'c2'}});
  await mgr.handleVoiceStateUpdate({t:'VOICE_STATE_UPDATE',d:{user_id:'u1',guild_id:'g1',channel_id:'c1'}});
  await mgr.handleVoiceStateUpdate({t:'VOICE_STATE_UPDATE',d:{user_id:'u1',guild_id:'g1',channel_id:null}});
  assert.equal(fv.calls.joinVoice,1);
  assert.equal(fv.streamer.createStreamCalls,1);
});

test('$stop discards queued content, awaits writer cleanup and is idempotent', async t => {
  const {mgr,fv,start}=fixture(t);await start('a');await start('b');
  await Promise.all([mgr.stop(),mgr.leaveChannel()]);
  assert.equal(mgr.voiceLink,null);assert.equal(mgr.session,null);
  assert.equal(fv.pieces.length,1);assert.equal(fv.calls.leaveVoice,1);
});

test('encoder error alerts and advances queue without another go-live', async t => {
  const {mgr,fv,start,alerts}=fixture(t,{streamBufferSec:0});await start('a');await start('b');
  fv.pieces[0].fail();await until(()=>fv.pieces.length===2);
  assert(alerts.some(a=>a.event==='stream-error' && /encoder failed/.test(a.detail)));
  assert.equal(fv.plays.length,1);assert.equal(fv.calls.stopStream,0);
  assert.equal(mgr.session.title,'b');
});

test('persistent track startup failure reports failure, never clean content EOF', async t => {
  const {mgr,start,alerts}=fixture(t,{}, {failStart:true});await start('a');
  await until(()=>mgr.voiceLink===null);
  assert(alerts.some(a=>a.event==='stream-error'));assert(!alerts.some(a=>a.event==='stream-ended'));
});

test('play acknowledges the exact createStream connection instead of stale library state', async t => {
  const staleInternalConnection = () => {
    const streamer = makeStreamerInstance();
    streamer.createStream = async () => {
      streamer.createStreamCalls += 1;
      // Reproduce the deployed regression: media uses the successfully
      // returned connection, while the mutable internal pointer references a
      // different/non-ready connection.
      streamer.voiceConnection.streamConnection = { webRtcConn: { ready: false } };
      return { ready: true };
    };
    return streamer;
  };
  const {start,fv}=fixture(t,{playStreamStartTimeoutMs:35},{streamerFactory:staleInternalConnection});
  const result=await start('a');
  assert.equal(result.ok,true);
  assert.equal(fv.streamer.createStreamCalls,1);
});

test('gateway watchdog fails once and cleans up a pending handshake', async t => {
  const {mgr,fv,start,alerts}=fixture(t,{playStreamStartTimeoutMs:35},{hang:true});
  const r=await start('a');assert(!r.ok);
  await until(()=>mgr.voiceLink===null);
  assert.equal(fv.plays.length,1);assert.equal(fv.calls.leaveVoice,1);
  assert(alerts.some(a=>/did not start/.test(a.detail)));
});

test('concurrent starts acquire one voice link and queue in order', async t => {
  const {mgr,fv,start}=fixture(t,{streamBufferSec:0});
  const results=await Promise.all([start('a'),start('b'),start('c')]);
  assert(results.every(r=>r.ok));assert.equal(fv.calls.joinVoice,1);assert.equal(fv.plays.length,1);
  assert.deepEqual(mgr.voiceLink.pipeline.enqueue.map(p=>p.title),['b','c']);
});

test('queue limit rejects overflow without interrupting playback', async t => {
  const {mgr,fv,start}=fixture(t,{streamQueueLimit:1});
  await start('a');assert((await start('b')).ok);assert(!(await start('c')).ok);
  assert.equal(mgr.session.title,'a');assert.equal(fv.calls.stopStream,0);
});

test('one persistent track session is used regardless of legacy startup burst setting', async t => {
  for (const burst of [0,4]) {
    const {fv,start,mgr}=fixture(t,{startBurstSec:burst});
    await start('a');await start('b');
    assert.equal(fv.plays.length,1);await mgr.stop();
  }
});

test('registry: $join handler is registered and routes to ensureChannel (idempotent, no re-join)', async t => {
  const {mgr,fv,alerts}=fixture(t);
  const client=mgr.client;
  const registry = new CommandRegistry({ client, streamManager: mgr });

  assert.strictEqual(registry.has('join'), true, 'the registry must expose join');
  assert.ok(!registry.commands.has('joinx'), 'unknown names still rejected by dispatch');

  const a = makeMessage();
  await registry.dispatch(a.message, 'join');
  assert.strictEqual(fv.streamer.calls.joinVoice, 1, 'the first $join must join the voice channel');
  assert.strictEqual(fv.streamer.calls.leaveVoice, 0);
  assert.strictEqual(mgr.voiceLink && mgr.voiceLink.channelId, 'c1', 'the voiceLink must be recorded for c1');
  assert.strictEqual(a.replyTexts.length, 0, 'NO channel send — the restricted account must never send');
  const joinAlerts = alerts.filter((x) => x.event === 'cmd');
  assert.ok(joinAlerts.length >= 1, 'the confirmation must be forwarded to the alert sink');
  assert.ok(/c1|in the room/i.test(joinAlerts[joinAlerts.length - 1].detail), 'the sink detail must carry the confirmation text');

  // Second $join — idempotent: NO re-join, no message storm.
  const before = fv.streamer.calls.joinVoice;
  const b = makeMessage({ replyTexts: [] });
  await registry.dispatch(b.message, 'join');
  assert.strictEqual(fv.streamer.calls.joinVoice, before, 'a second $join must NOT re-join (idempotency)');
  assert.strictEqual(fv.streamer.calls.leaveVoice, 0);
  assert.strictEqual(b.replyTexts.length, 0, 'still NO channel send');
  assert.ok(alerts.filter((x) => x.event === 'cmd').length >= 2, 'a second confirming alert should still be forwarded');
});

test('registry: $stop dispatches to the manager.stop() path (leaves the channel and kills the stream)', async t => {
  const {mgr,fv,alerts}=fixture(t);
  const client=mgr.client;
  const registry = new CommandRegistry({ client, streamManager: mgr });

  const a = makeMessage();
  await registry.dispatch(a.message, 'stream https://example.com/a.mp4');
  assert.strictEqual(fv.streamer.calls.joinVoice, 1, 'a stream must have started');
  assert.strictEqual(a.replyTexts.length, 0, 'NO channel send from the start confirmation');

  const b = makeMessage({ replyTexts: [] });
  await registry.dispatch(b.message, 'stop');
  assert.strictEqual(mgr.session, null);
  assert.strictEqual(mgr.voiceLink, null, '$stop must clear the voiceLink');
  assert.strictEqual(fv.streamer.calls.leaveVoice, 1, '$stop must leave the voice channel');
  assert.strictEqual(b.replyTexts.length, 0, 'NO channel send for the $stop confirmation');
  assert.ok(
    alerts.some((x) => x.event === 'cmd' && x.detail === M.STREAM_STOPPED),
    'the $stop confirmation must be forwarded to the alert sink'
  );
});

test('joinVoice that never resolves times out cleanly and does not wedge the lock', async t => {
  // Fake streamer whose joinVoice NEVER settles (restricted selfbot gateway:
  // no VOICE_STATE_UPDATE/VOICE_SERVER_UPDATE ever arrives).
  function hungStreamerFactory() {
    const base = makeStreamerInstance();
    base.joinVoice = () => { base.calls.joinVoice += 1; return new Promise(() => {}); }; // never settles
    return base;
  }
  const f = fixture(t, { joinVoiceTimeoutMs: 800 }, { streamerFactory: hungStreamerFactory });
  const started = Date.now();
  const r = await f.start('a');
  assert.equal(r.ok, false, 'start must fail, not hang');
  assert.equal(r.message, M.STREAM_JOIN_TIMEOUT, 'the user-facing message must be the timeout text');
  assert.ok(Date.now() - started < 2000, 'must settle within ~2s, not hang forever');
  assert.equal(f.mgr.voiceLink, null, 'no voice link may be recorded after a failed join');
  assert.ok(f.alerts.some(a => a.event === 'stream-error' && /timed out after/.test(a.detail)),
    'the failure must be reported to the alert sink');
  // THE lock must be released: a second start runs its own full path
  // (re-enters the same hung joinVoice, times out again) instead of
  // deadlocking behind the first one.
  const r2 = await f.mgr.start({guildId:'g1',channelId:'c1',streamUrl:'https://example.com/b.mp4',title:'b'});
  assert.equal(r2.ok, false, 'second start must also settle, not deadlock on the serialize lock');
  assert.equal(r2.message, M.STREAM_JOIN_TIMEOUT);
  // A third start resolves the lock liveness independently.
  const r3 = await f.mgr.start({guildId:'g1',channelId:'c1',streamUrl:'https://example.com/c.mp4',title:'c'});
  assert.equal(r3.ok, false);
  assert.equal(f.fv.streamer.calls.joinVoice, 3, 'every start re-attempts the join');
});

test('joinVoice happy path retains existing behavior', async t => {
  const f = fixture(t, { joinVoiceTimeoutMs: 5000 });
  const r = await f.start('a');
  assert.equal(r.ok, true, 'a settling joinVoice must still succeed');
  assert.equal(f.fv.streamer.calls.joinVoice, 1);
  assert.equal(f.mgr.voiceLink.channelId, 'c1');
  const r2 = await f.start('b');
  assert.equal(r2.ok, true);
  assert.equal(f.fv.calls.joinVoice, 1, 'second start reuses the live link (no re-join)');
  assert.equal(f.fv.pieces.length, 1);
  await f.mgr.stop();
});

test('config: streamBufferSec default is 15 and honors env override', () => {
  const old = process.env.SELF_BOT_TOKEN;
  process.env.SELF_BOT_TOKEN = 'test';
  try {
    const cfg = require('../src/streambot/config').loadConfig();
    assert.equal(cfg.streamBufferSec, Number(process.env.SBOT_STREAM_BUFFER_SEC) || 15);
  } finally { if (old === undefined) delete process.env.SELF_BOT_TOKEN; else process.env.SELF_BOT_TOKEN=old; }
});

test('buffer is inserted before a real piece while a real piece is active', async t => {
  const {mgr,fv,start}=fixture(t); // default buffer = 15
  const a = await start('a');
  assert.equal(a.bufferInserted, false, 'first real piece must NOT have a leading buffer');
  const b = await start('b');
  assert.equal(b.bufferInserted, true, 'second real piece must be preceded by a buffer filler');
  // The buffer is queued immediately BEFORE 'b' in the pipeline queue.
  const queue = mgr.voiceLink.pipeline.enqueue;
  const bIdx = queue.findIndex(q => q.title === 'b');
  assert.ok(bIdx >= 0, 'the "b" piece must be in the queue');
  assert.ok(bIdx >= 1, 'a piece must be BEFORE "b" in the queue (the buffer)');
  const buf = queue[bIdx - 1];
  assert.equal(buf.isFiller, true, 'the piece before "b" must be a filler buffer');
  assert.equal(buf.title, 'buffer', 'the buffer title must be "buffer"');
  assert.match(buf.streamUrl || '', /testsrc/, 'the buffer must be a testsrc/lavfi filler (same codec path as the placeholder)');
  await mgr.stop();
});

test('no buffer for the first real on an idle pipeline; buffer for subsequent reals', async t => {
  const {mgr,fv,start}=fixture(t);
  const a = await start('a');
  assert.equal(a.bufferInserted, false, 'first real: no leading buffer');
  const b = await start('b');
  assert.equal(b.bufferInserted, true, 'second real: buffer inserted');
  await mgr.stop();
});

test('buffer disabled (streamBufferSec 0) inserts nothing between reals', async t => {
  const {mgr,fv,start}=fixture(t,{streamBufferSec:0});
  const a = await start('a');
  const b = await start('b');
  assert.equal(b.bufferInserted, false, 'b must NOT report a buffer when disabled');
  // Drive all pieces to completion and assert pure ABC ordering (no filler bytes).
  fv.pieces[0].write('A'); fv.pieces[0].end();
  await until(()=>fv.pieces.length===2);
  fv.pieces[1].write('B'); fv.pieces[1].end();
  await until(()=>mgr.session===null);
  const joined = fv.collected.join('');
  assert.equal(joined,'AB', 'no filler bytes between the two reals');
  await mgr.stop();
});

test('$skip advances to the next real piece (buffer in between)', async t => {
  const {mgr,fv,start}=fixture(t);
  await start('a');
  await start('b'); // queue: [buffer, b]
  const r = await mgr.skip();
  assert.equal(r.ok, true);
  assert.equal(r.noOp, false);
  assert.equal(r.fellBackToFiller, false, 'there is a real queued ahead — no filler fallback');
  assert.equal(r.skippedTo, 'b', 'the skip must advance to the next non-filler piece titled "b"');
  // The pump has advanced: the active writer is no longer the cancelled "a"
  // (it is the buffer filler). The fake SIGTERM path through the fluent-ffmpeg
  // close/event cycle can take a few ms, so allow up to ~2s.
  for (let i = 0; i < 200; i++) {
    if (mgr.voiceLink?.pipeline?.activeWriter?.title !== 'a') break;
    await new Promise(r => setTimeout(r, 10));
  }
  assert(mgr.voiceLink?.pipeline?.activeWriter?.title !== 'a',
    'the active writer must no longer be the cancelled "a" piece');
  // Drive the buffer piece (the first filler piece after the cancelled "a").
  // The fake `prepareStream` records the piece by url, not title, so match by url.
  const bufIdx = fv.pieces.findIndex(p => /testsrc/.test(p.url));
  assert.ok(bufIdx >= 0, 'the buffer (testsrc/lavfi filler) piece must have started');
  fv.pieces[bufIdx].write(''); fv.pieces[bufIdx].end();
  // The real "b" piece must then start. It is the 3rd (index 2) piece created
  // by the fixture, but we match by url to be robust against ordering.
  await until(() => fv.pieces.some(p => /\/b\.mp4/.test(p.url)));
  const bIdx = fv.pieces.findIndex(p => /\/b\.mp4/.test(p.url));
  assert.ok(bIdx >= 0, 'the "b" piece must have started');
  fv.pieces[bIdx].write('B'); fv.pieces[bIdx].end();
  await until(() => mgr.session === null);
  // The go-live session was NOT torn down.
  assert.equal(fv.plays.length, 1, 'exactly ONE go-live playStream for the link lifetime');
  assert.equal(fv.calls.stopStream, 0, 'skip must NOT call stopStream');
  assert.deepEqual(fv.calls.signalVideo, [], 'go-live must not toggle the separate camera state');
  await mgr.stop();
});

test('$skip with an empty queue falls back to the filler placeholder', async t => {
  const {mgr,fv,start}=fixture(t,{streamBufferSec:0});
  await start('a');
  // No piece queued ahead (buffer disabled).
  const r = await mgr.skip();
  assert.equal(r.ok, true);
  assert.equal(r.fellBackToFiller, true, 'the queue is empty after skip — must fall back to filler');
  assert.equal(r.noOp, false);
  // The placeholder must now be in the queue (or already active).
  const p = mgr.voiceLink.pipeline;
  const filler = p.enqueue.find(q => q.isFiller) || p.activeWriter;
  assert(filler, 'a filler must be queued/active after the fallback');
  assert.equal(filler.isFiller, true);
  assert.match(filler.streamUrl || '', /testsrc/);
  // The go-live session was NOT torn down.
  assert.equal(fv.plays.length, 1, 'skip must NOT tear down the persistent go-live stream');
  assert.equal(fv.calls.stopStream, 0);
  assert.deepEqual(fv.calls.signalVideo, []);
  await mgr.stop();
});

test('$skip is a no-op when nothing is active and the queue is empty', async t => {
  const {mgr,fv}=fixture(t);
  const r = await mgr.skip();
  assert.equal(r.ok, true);
  assert.equal(r.noOp, true);
  assert.equal(r.skippedTo, null);
  assert.equal(r.fellBackToFiller, false);
  assert.equal(r.queued, 0);
  assert.equal(fv.plays.length, 0, 'no playStream must have been started');
  assert.equal(mgr.voiceLink, null, 'no voice link should exist after a no-op skip');
  await mgr.stop();
});

test('registry: $skip is registered and routes to the manager.skip() path', async t => {
  const {mgr,fv,alerts}=fixture(t);
  const client=mgr.client;
  const registry = new CommandRegistry({ client, streamManager: mgr });
  assert.strictEqual(registry.has('skip'), true, 'the registry must expose $skip');
  // Start one real, then dispatch $skip — this should cancel the active and
  // reply with SKIP_FILLER (queue empty, fillerOnJoin default is true but no
  // filler was enqueued here since we used $stream directly, not $join).
  const a = makeMessage();
  await registry.dispatch(a.message, 'stream https://example.com/a.mp4');
  assert.strictEqual(a.replyTexts.length, 0, 'NO channel send from the start confirmation');
  const b = makeMessage({ replyTexts: [] });
  await registry.dispatch(b.message, 'skip');
  assert.strictEqual(b.replyTexts.length, 0, 'NO channel send from the $skip reply (restricted account)');
  const skipAlerts = alerts.filter((x) => x.event === 'cmd');
  assert.ok(skipAlerts.some((x) => /Skipping|filler|skip/i.test(x.detail)),
    'the $skip confirmation must be forwarded to the alert sink');
  await mgr.stop();
});

// ============================================================================
// Playback controls: $scrub / $pause / $resume / $catchup
// ============================================================================

test('parseSignedDuration: +10m/-90s/+1h/+1h30m/+120 and invalid', () => {
  assert.strictEqual(parseSignedDuration('+10m'), 600);
  assert.strictEqual(parseSignedDuration('-90s'), -90);
  assert.strictEqual(parseSignedDuration('+1h'), 3600);
  assert.strictEqual(parseSignedDuration('+1h30m'), 5400);
  assert.strictEqual(parseSignedDuration('+120'), 120);
  // no explicit sign defaults to positive
  assert.strictEqual(parseSignedDuration('10m'), 600);
  assert.strictEqual(parseSignedDuration('-1h30m'), -5400);
  // invalid / empty → null
  assert.strictEqual(parseSignedDuration(''), null);
  assert.strictEqual(parseSignedDuration('abc'), null);
  assert.strictEqual(parseSignedDuration('+'), null);
  assert.strictEqual(parseSignedDuration('--5'), null);
  assert.strictEqual(parseSignedDuration('10x'), null);
  assert.strictEqual(parseSignedDuration(null), null);
  assert.strictEqual(parseSignedDuration(undefined), null);
});

test('$scrub on a VOD advances the piece and keeps ONE go-live', async t => {
  const { mgr, fv, start } = fixture(t, { streamBufferSec: 0 });
  await start('a');
  const active = mgr.session;
  active.isLive = false;
  active.totalDurationSec = 3600;
  active.startOffsetSec = 0;
  active.startedAt = Date.now();
  const oldActive = mgr.session;
  const r = await mgr.scrub(600);
  assert.equal(r.ok, true);
  assert.equal(r.applied, true);
  assert.equal(r.reason, undefined, 'a VOD scrub must apply, not no-op');
  assert.equal(r.newPosSec, 600, 'position = 0 + 600');
  // the pump advances to the reopened piece (the old writer was cancelled);
  // await the transition, then inspect the NEW active writer.
  const p = mgr.voiceLink.pipeline;
  await until(() => p.activeWriter && p.activeWriter !== oldActive);
  const reopened = p.activeWriter;
  assert(reopened, 'a reopened piece must be active');
  assert.notEqual(reopened, oldActive, 'the active writer must be a NEW (reopened) piece');
  assert.equal(reopened.startOffsetSec, 600, 'the reopened piece carries the scrubbed offset');
  assert.equal(reopened.isFiller, false);
  // the go-live session was NOT torn down
  assert.equal(fv.plays.length, 1, 'exactly ONE go-live playStream for the link lifetime');
  assert.equal(fv.calls.stopStream, 0, 'scrub must NOT call stopStream');
  assert.deepEqual(fv.calls.signalVideo, [], 'go-live must not toggle the separate camera state');
  assert.equal(fv.streamer.calls.leaveVoice, 0, 'scrub must NOT leave the voice channel');
  await mgr.stop();
});

test('$scrub on a filler/no-content is a no-op and does NOT tear down', async t => {
  const { mgr, fv } = fixture(t);
  await mgr.ensureChannel('g1', 'c1'); // only the join placeholder/filler
  assert(mgr.session?.isFiller, 'a filler must be active');
  const r = await mgr.scrub(120);
  assert.equal(r.ok, true);
  assert.equal(r.noOp, true);
  assert.equal(r.reason, 'filler');
  assert(!r.applied, 'a filler scrub must NOT be applied');
  assert.equal(fv.plays.length, 1, 'the go-live session must remain');
  assert.equal(fv.calls.stopStream, 0, 'scrub must NOT tear down');
  assert.deepEqual(fv.calls.signalVideo, []);
  await mgr.stop();
});

test('$scrub on a live piece is a no-op (applied:false, reason live) and does NOT restart', async t => {
  const { mgr, fv, start } = fixture(t, { streamBufferSec: 0 });
  await start('a');
  const active = mgr.session;
  active.isLive = true;
  const beforePieces = fv.pieces.length;
  const r = await mgr.scrub(300);
  assert.equal(r.ok, true);
  assert.equal(r.noOp, true);
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'live');
  await until(() => (active.control.signal.aborted === false) || mgr.session === active);
  assert.equal(mgr.session, active, 'the active live piece must NOT be replaced');
  assert.equal(fv.plays.length, 1);
  assert.equal(fv.calls.stopStream, 0);
  assert.deepEqual(fv.calls.signalVideo, []);
  await mgr.stop();
});

test('$pause stops feeding without tearing down and does NOT advance a queued piece', async t => {
  const { mgr, fv, start } = fixture(t, { streamBufferSec: 0 });
  await start('a');
  await start('b'); // queue: [b]; active: a
  const active = mgr.session; // 'a'
  assert.equal(active.title, 'a');
  active.isLive = false; active.totalDurationSec = 3600; active.startedAt = Date.now();
  const r = await mgr.pause();
  assert.equal(r.ok, true);
  assert.equal(r.paused, true);
  assert.equal(mgr.voiceLink.paused, true);
  // Hold: the queued 'b' must NOT start. Poll well beyond normal settle window.
  for (let i = 0; i < 100; i++) {
    if (fv.pieces.some(p => /\/b\.mp4/.test(p.url))) { assert.fail('paused hold: queue advanced to b'); }
    await new Promise(res => setTimeout(res, 10));
  }
  assert.ok(!fv.pieces.some(p => /\/b\.mp4/.test(p.url)), 'the pump must NOT start the next queued item while paused');
  // no teardown of the go-live session
  assert.equal(fv.plays.length, 1, 'exactly ONE go-live');
  assert.equal(fv.calls.stopStream, 0, 'pause must NOT call stopStream');
  assert.equal(fv.streamer.calls.leaveVoice, 0, 'pause must NOT leave the channel');
  assert.deepEqual(fv.calls.signalVideo, []);
  assert(!mgr.voiceLink.pipeline.closed, 'the shared WebRTC tracks stay open');
  await mgr.stop();
});

test('$resume re-opens the paused VOD at the held position and resumes feeding', async t => {
  const { mgr, fv, start } = fixture(t, { streamBufferSec: 0 });
  await start('a');
  const active = mgr.session; // 'a'
  active.isLive = false; active.totalDurationSec = 3600; active.startedAt = Date.now();
  await mgr.pause();
  const rr = await mgr.resume();
  assert.equal(rr.ok, true);
  assert.equal(rr.resumed, true);
  assert.equal(mgr.voiceLink.paused, false, 'pause flag must clear');
  // The pump runs again (VOD resumes at the held position — a reopened piece).
  await until(() => fv.pieces.length >= 2);
  assert.equal(fv.plays.length, 1, 'exactly ONE go-live for the link lifetime');
  assert.equal(fv.calls.stopStream, 0);
  assert.deepEqual(fv.calls.signalVideo, []);
  const p = mgr.voiceLink.pipeline;
  const active2 = p.activeWriter;
  assert(active2, 'a piece must be active after resume');
  assert.equal(active2.isFiller, false, 'resume must not fall back to filler');
  assert.equal(active2.title, 'a', 'the VOD resumes the SAME stream');
  await mgr.stop();
});

test('$catchup on a live piece restarts at offset 0 and keeps ONE go-live', async t => {
  const { mgr, fv, start } = fixture(t, { streamBufferSec: 0 });
  await start('a');
  const active = mgr.session;
  active.isLive = true; active.totalDurationSec = null; active.startedAt = Date.now();
  const oldActive = mgr.session;
  const r = await mgr.catchup();
  assert.equal(r.ok, true);
  assert.equal(r.applied, true);
  const p = mgr.voiceLink.pipeline;
  await until(() => p.activeWriter && p.activeWriter !== oldActive);
  const reopened = p.activeWriter;
  assert(reopened, 'a reopened piece must be active');
  assert.notEqual(reopened, oldActive, 'the active writer must be a NEW (reopened) piece');
  assert.equal(reopened.startOffsetSec, 0, 'catchup rewinds the live piece to the head (offset 0)');
  assert.equal(reopened.isLive, true);
  assert.equal(fv.plays.length, 1, 'exactly ONE go-live');
  assert.equal(fv.calls.stopStream, 0);
  assert.deepEqual(fv.calls.signalVideo, []);
  await mgr.stop();
});

test('$catchup on a VOD (not live) is applied:false and does NOT restart', async t => {
  const { mgr, fv, start } = fixture(t, { streamBufferSec: 0 });
  await start('a');
  const active = mgr.session;
  active.isLive = false; active.totalDurationSec = 3600; active.startedAt = Date.now();
  const r = await mgr.catchup();
  assert.equal(r.ok, true);
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'not-live');
  await until(() => true); // settle; nothing should have changed
  assert.equal(mgr.session, active, 'the VOD piece must NOT be replaced');
  assert.equal(fv.plays.length, 1);
  assert.equal(fv.calls.stopStream, 0);
  await mgr.stop();
});

test('registry: scrub/pause/resume/catchup are registered and reply (no channel send)', async t => {
  const { mgr, fv, alerts } = fixture(t, { streamBufferSec: 0 });
  const client = mgr.client;
  const registry = new CommandRegistry({ client, streamManager: mgr });
  assert.strictEqual(registry.has('scrub'), true);
  assert.strictEqual(registry.has('pause'), true);
  assert.strictEqual(registry.has('resume'), true);
  assert.strictEqual(registry.has('catchup'), true);

  const a = makeMessage();
  const s = await mgr.start({ guildId: 'g1', channelId: 'c1', streamUrl: 'https://example.com/a.mp4', title: 'a' });
  assert(s.ok);
  const active = mgr.session; active.isLive = false; active.totalDurationSec = 3600; active.startedAt = Date.now();

  const b = makeMessage({ replyTexts: [] });
  await registry.dispatch(b.message, 'scrub +10m');
  assert.strictEqual(b.replyTexts.length, 0, 'NO channel send from $scrub (restricted account)');
  assert.ok(alerts.some(x => x.event === 'cmd' && /Scrubbed to/i.test(x.detail)), 'scrub confirmation must reach the alert sink');

  const c = makeMessage({ replyTexts: [] });
  await registry.dispatch(c.message, 'pause');
  assert.strictEqual(c.replyTexts.length, 0, 'NO channel send from $pause');
  assert.ok(alerts.some(x => x.event === 'cmd' && /Paused/i.test(x.detail)), 'pause confirmation must reach the alert sink');

  const d = makeMessage({ replyTexts: [] });
  await registry.dispatch(d.message, 'resume');
  assert.strictEqual(d.replyTexts.length, 0, 'NO channel send from $resume');
  assert.ok(alerts.some(x => x.event === 'cmd' && /Resumed/i.test(x.detail)), 'resume confirmation must reach the alert sink');

  const e = makeMessage({ replyTexts: [] });
  await registry.dispatch(e.message, 'catchup');
  assert.strictEqual(e.replyTexts.length, 0, 'NO channel send from $catchup');
  assert.ok(alerts.some(x => x.event === 'cmd' && /not.*live|catch/i.test(x.detail)), 'catchup on a VOD must reply not-live via the alert sink');
  await mgr.stop();
});
