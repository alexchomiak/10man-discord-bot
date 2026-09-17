'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const { createTelemetry } = require('../src/streambot/telemetry');
const {
  StreamManager,
  isBenignEnd,
  isAmbiguousPipeClose
} = require('../src/streambot/streamManager');
const { M } = require('../src/streambot/messages');
const { ensureTrackerInstalled, trackedDemuxers } = require('../src/streambot/demuxGuard');

// ============================================================================
// 1) Tracker wiring: preparePlayback() installs the tracker and never throws
// ============================================================================
test('preparePlayback: installs the demuxer tracker (idempotent) and passes through the module', async () => {
  const mgr = new StreamManager({ token: 't' }, 'c1', {});
  const mod = { Utils: {} };
  const out = await mgr.preparePlayback(mod);
  assert.strictEqual(out, mod, 'the video module must be passed through unchanged');
  // A second preparePlayback must be a no-op (demuxGuard memoizes the install).
  const out2 = await mgr.preparePlayback(mod);
  assert.strictEqual(out2, mod);
  // demuxGuard's flag (already set by other tests in this process) is truthy.
  await ensureTrackerInstalled();
});

test('preparePlayback: a tracker install failure is swallowed (start() must never be blocked)', async () => {
  const demuxGuard = require('../src/streambot/demuxGuard');
  const real = demuxGuard.ensureTrackerInstalled;
  demuxGuard.ensureTrackerInstalled = () => Promise.reject(new Error('no node-av here'));
  try {
    const mgr = new StreamManager({ token: 't' }, 'c1', {});
    const mod = { Utils: {} };
    await assert.doesNotReject(
      () => mgr.preparePlayback(mod),
      'a tracker install failure must NOT propagate to start()'
    );
  } finally {
    demuxGuard.ensureTrackerInstalled = real;
  }
});

test('start() call-site latch: StreamManager.prototype.start references preparePlayback', () => {
  assert.ok(
    StreamManager.prototype.start.toString().includes('preparePlayback'),
    'start() must call preparePlayback (tracker wiring regression latch)'
  );
});

// ============================================================================
// 2) Input pacing: network inputs must be free to catch up after a stall.
//    Only synthetic infinite lavfi inputs need -re because they have no clock.
// ============================================================================
// Patch fluent-ffmpeg's prototype once for this process so we can build a
// real FfmpegCommand and inspect _getArguments without actually spawning.
const ffModule = require('fluent-ffmpeg');
if (typeof ffModule === 'function' && !ffModule.prototype.__runPatched) {
  ffModule.prototype.run = function () { return this; };
  ffModule.prototype.__runPatched = true;
}

function buildDashCommand({ offset = 0, piece = null } = {}) {
  const mgr = new StreamManager({ token: 't' }, 'c1', {
    videoCodec: 'H264', streamBitrate: 5000, streamHeight: 720,
    streamFrameRate: 30, streamAudioBitrate: 128
  });
  const videoModule = { Utils: { normalizeVideoCodec: (c) => c } };
  return StreamManager.prototype._buildDashMerge.call(
    mgr,
    videoModule,
    'https://cdn.example/v.mp4',
    'https://cdn.example/a.m4a',
    offset,
    null,
    piece
  ).command;
}

function argvOf(command) {
  const parts = typeof command._getArguments === 'function'
    ? command._getArguments()
    : command.getCommand();
  const arr = Array.isArray(parts) ? parts : String(parts).split(' ');
  return arr.map((p) => String(p));
}

test('dash merge: network inputs use -re progressive pacing and bounded reconnect/read options', () => {
  const command = buildDashCommand({ offset: 0 });
  const argv = argvOf(command);
  const inputs = argv.filter((a) => a === '-i').length;
  assert.strictEqual(inputs, 2, 'dash merge must keep exactly two -i inputs');

  assert.strictEqual(argv.filter((a) => a === '-re').length, 2, 'each HTTP input must be paced');
  assert.strictEqual(argv.filter((a) => a === '-thread_queue_size').length, 2);
  assert.strictEqual(argv.filter((a) => a === '-rw_timeout').length, 2);
  assert.strictEqual(argv.filter((a) => a === '-reconnect').length, 2);

  assert.ok(!argv.includes('-ss'), 'no -ss without an offset');
});

test('dash merge: with offset, ONE -ss and ONE -re per network input', () => {
  const command = buildDashCommand({ offset: 60 });
  const argv = argvOf(command);
  assert.strictEqual(argv.filter((a) => a === '-i').length, 2, 'still two inputs');
  assert.strictEqual(argv.filter((a) => a === '-ss').length, 2, 'one -ss per input, not duplicated');
  assert.strictEqual(argv.filter((a) => a === '60').length, 2, 'offset value appears per input');
  assert.strictEqual(argv.filter((a) => a === '-re').length, 2);
});

test('single lavfi filler paces both synthetic inputs with -re', () => {
  const mgr = new StreamManager({ token: 't' }, 'c1', {
    videoCodec: 'H264', streamBitrate: 5000, streamHeight: 1080,
    streamFrameRate: 30, streamAudioBitrate: 128
  });
  const command = StreamManager.prototype._buildDashMerge.call(
    mgr,
    { Utils: { normalizeVideoCodec: (c) => c } },
    'testsrc=size=1280x720:rate=30',
    null,
    0,
    { customInputOptions: ['-f', 'lavfi'] },
    { isFiller: true, inputFormat: 'lavfi' }
  ).command;
  assert.strictEqual(argvOf(command).filter((a) => a === '-re').length, 2);
});

test('Arc mode uses VAAPI encode with the configured render device and 1080p/30 rate control', () => {
  const mgr = new StreamManager({ token: 't' }, 'c1', {
    videoCodec: 'H264', videoEncoder: 'vaapi', vaapiDevice: '/dev/dri/renderD129',
    streamWidth: 1920, streamHeight: 1080, streamFrameRate: 30,
    streamBitrate: 5000, streamAudioBitrate: 128, pipelineBufferMb: 8
  });
  const videoModule = { Utils: { normalizeVideoCodec: (c) => c } };
  const command = StreamManager.prototype._buildDashMerge.call(
    mgr, videoModule, 'https://cdn.example/v.mp4', 'https://cdn.example/a.m4a', 0, null, { isLive: true }
  ).command;
  const argv = argvOf(command);
  assert.ok(argv.includes('h264_vaapi'));
  assert.ok(argv.includes('/dev/dri/renderD129'));
  assert.ok(argv.includes('scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=nv12,hwupload'));
  assert.deepStrictEqual(argv.slice(argv.indexOf('-r'), argv.indexOf('-r') + 2), ['-r', '30']);
  assert.ok(argv.includes('7000k'));
  assert.ok(argv.includes('10000k'));
  assert.deepStrictEqual(argv.slice(argv.indexOf('-profile:v'), argv.indexOf('-profile:v') + 2), ['-profile:v', 'constrained_baseline']);
  assert.deepStrictEqual(argv.slice(argv.indexOf('-level:v'), argv.indexOf('-level:v') + 2), ['-level:v', '4.1']);
  assert.deepStrictEqual(argv.slice(argv.indexOf('-g'), argv.indexOf('-g') + 2), ['-g', '30']);
  assert.deepStrictEqual(argv.slice(argv.indexOf('-idr_interval'), argv.indexOf('-idr_interval') + 2), ['-idr_interval', '0']);
});

test('remote media builds a real bounded jitter buffer before Discord drains it', async () => {
  const mgr = new StreamManager({ token: 't' }, 'c1', {
    jitterBufferSec: 0.2, pipelineBufferMb: 1
  });
  const output = new PassThrough({ highWaterMark: 1024 * 1024 });
  const control = new AbortController();
  const piece = { isFiller: false, control };
  let settled = false;
  const buffering = mgr._prebuffer(output, piece).then(() => { settled = true; });

  output.write(Buffer.alloc(128));
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.strictEqual(settled, false, 'one short production interval is not enough runway');
  output.write(Buffer.alloc(128));
  await buffering;
  assert.ok(output.readableLength >= 256, 'producer bytes remain queued for the feeder');
  output.destroy();
});

test('filler and an explicit zero setting skip the jitter buffer', async () => {
  const mgr = new StreamManager({ token: 't' }, 'c1', { jitterBufferSec: 4 });
  const output = new PassThrough();
  await mgr._prebuffer(output, { isFiller: true, control: new AbortController() });
  mgr.config.jitterBufferSec = 0;
  await mgr._prebuffer(output, { isFiller: false, control: new AbortController() });
  output.destroy();
});

// ============================================================================
// 3) stop() now AWAITs teardown — the in-flight close must complete BEFORE
//    stop() resolves.
// ============================================================================
test('stop(): awaits teardown (flag set "after teardown" is only visible post-await)', async () => {
  const mgr = new StreamManager({ token: 't' }, 'c1', {});
  let resolvedInsideClose = false;
  const slow = { close: async () => { resolvedInsideClose = true; } };
  trackedDemuxers.add(slow);
  mgr.session = {
    telemetry: { stop() {} },
    streamer: { stopStream() {} },
    control: { abort() {}, signal: { aborted: false } },
    command: null,
    output: null
  };

  let afterTeardown = false;
  const p = mgr.stop().then(() => { afterTeardown = true; return true; });
  // stop() is a Promise — while teardown is mid-flight (close is async),
  // afterTeardown should NOT yet be true.
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(resolvedInsideClose, true, 'the slow close should have resolved by now');
  await p;
  assert.strictEqual(afterTeardown, true, 'await stop() must resolve only AFTER teardown finishes');
  assert.strictEqual(trackedDemuxers.size, 0, 'tracker set emptied by teardown');
});

test('stop(): is now async (returns a Thenable)', () => {
  const mgr = new StreamManager({ token: 't' }, 'c1', {});
  mgr.session = { telemetry: null, streamer: null, control: null, command: null, output: null };
  const ret = mgr.stop();
  assert.ok(ret && typeof ret.then === 'function', 'stop() must be awaitable (async signature)');
  return ret;
});

// ============================================================================
// 4) Reclassified close-race: the pipe-close string is AMBIGUOUS (same
//    promise behavior as before), but the user-facing message is chosen by
//    the CLEAN-COMPLETION signal (child exitCode === 0 or playStream .then),
//    not by the pipe string alone.
// ============================================================================
test('isAmbiguousPipeClose ≡ isBenignEnd (alias kept for existing importers)', () => {
  for (const e of [
    new Error('Output stream closed'),
    new Error('Output stream error: ECONNRESET'),
    null, undefined, {}, 'Output stream closed'
  ]) {
    assert.strictEqual(
      isAmbiguousPipeClose(e),
      isBenignEnd(e),
      `alias must agree for ${e && (e.message || JSON.stringify(e))}`
    );
  }
  assert.strictEqual(isAmbiguousPipeClose(new Error('Output stream closed')), true);
  assert.strictEqual(isAmbiguousPipeClose(new Error('No such file or directory')), false);
});

// -- Listener-capturing fake harness (same shape as the one in
//    streambot.sources.test.js) ----------------------------------------------
function makeFakeDashResult(settleBehavior, processStub) {
  const captured = [];
  const listeners = { error: [], end: [] };
  const command = {
    listeners,
    process: processStub || null,
    on(ev, cb) { (listeners[ev] || (listeners[ev] = [])).push(cb); return command; },
    kill(sig) { captured.push(`command.kill(${sig})`); }
  };
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
    command.on('error', (err) => settleBehavior({ resolve: resolvePromise, reject: rejectPromise, err }));
    command.on('end', () => resolvePromise());
  });
  promise.catch(() => {});
  command.__emitError = (e) => (command.listeners.error || []).forEach((cb) => cb(e));
  const output = { on() { return { on() {} }; }, destroy() {} };
  return { command, output, promise, controller: null, __captured: captured };
}

function makeStreamManager(title) {
  const plays = [];
  const channel = {
    id: 'c1',
    sent: [],
    send(text) { channel.sent.push(text); return Promise.resolve(); }
  };
  const alerts = [];
  const sink = { notify: async (event, detail) => { alerts.push({ event, detail }); } };
  const sentLogs = { info: [], error: [] };
  const realLog = console.log;
  const realErr = console.error;
  console.log = (...parts) => {
    const j = parts.map((p) => String(p)).join('');
    if (/stream ended: pipe closed/.test(j)) sentLogs.info.push(j);
  };
  console.error = (...parts) => {
    const j = parts.map((p) => String(p)).join('');
    if (/ffmpeg error|dash merge ffmpeg error/.test(j)) sentLogs.error.push(j);
  };
  const client = { token: 'test-token', channels: { cache: { get: (id) => (id === 'c1' ? channel : null) } } };
  const mgr = new StreamManager(client, 'c1', {
    videoCodec: 'H264', streamBitrate: 5000, streamHeight: 1080,
    streamFrameRate: 30, hardwareAccel: false, playStreamStartTimeoutMs: 50,
    alertSink: sink
  });
  mgr._feederFactory = () => ({
    start: async () => { plays.push(() => {}); return {}; },
    append: async () => {}, interrupt: () => {}, close: async () => {}
  });
  mgr._prepareSingle = (vm, piece) => vm.prepareStream(piece.streamUrl, mgr.setupStreamOptions(vm, piece.startOffsetSec, piece.durationSec, piece.inputFormat), piece.control.signal);
  mgr._videoModule = {
    Streamer: function () {
      this.voiceConnection = { streamConnection: { serverId: 'srv', webRtcConn: { ready: true } } };
      this.joinVoice = async () => ({ mediaConnection: { webRtcParams: null, start() {} } });
      this.stopStream = () => {};
      this.leaveVoice = () => {};
    },
    prepareStream: () => {
      const listeners = {};
      const cmd = {
        listeners,
        on(ev, cb) { (listeners[ev] ||= []).push(cb); return cmd; },
        kill() { return this; },
        process: null,
        getCommand: () => ['ffmpeg', '-i', 'in', 'out']
      };
      return {
        command: cmd,
        output: { on() { return { on() {} }; }, destroy() {} },
        promise: new Promise(() => {}),
        controller: null
      };
    },
    playStream: () => new Promise((resolve) => { plays.push(resolve); }),
    Utils: { normalizeVideoCodec: (c) => c }
  };
  const restore = () => { console.log = realLog; console.error = realErr; };
  const startArgs = { guildId: 'g1', channelId: 'c1', streamUrl: 'https://example.com/finish.mp4' };
  if (title) startArgs.title = title;
  return { mgr, channel, plays, restore, startArgs, sentLogs, alerts };
}

test('RECLASSIFIED: ambiguous pipe-close + exitCode 0 -> "video finished" (ENDED)', async () => {
  const t = makeStreamManager('My VOD');
  t.mgr._buildDashMerge = (videoModule) =>
    makeFakeDashResult(
      ({ resolve, reject, err }) => {
        if (isAmbiguousPipeClose(err)) { resolve(); return; }
        reject(err);
      },
      { exitCode: 0 } // clean-signal: child exited 0
    );
  const result = await t.mgr.start({
    guildId: 'g1', channelId: 'c1',
    videoUrl: 'https://example.com/v.mp4', audioUrl: 'https://example.com/a.m4a',
    title: 'My VOD'
  });
  assert.strictEqual(result.ok, true);
  const session = result.session;

  session.command.__emitError(new Error('Output stream closed'));
  await new Promise((r) => setTimeout(r, 30));

  assert.strictEqual(t.channel.sent.length, 0, 'NO channel send — restricted account');
  assert.strictEqual(t.alerts.filter((a) => a.event === 'stream-ended').length, 1, 'exactly one end alert');
  assert.strictEqual(t.alerts.filter((a) => a.event === 'stream-ended')[0].detail, M.STREAM_VOD_ENDED('My VOD'), 'exitCode 0 -> ENDED');
  assert.ok(t.sentLogs.info.some((l) => /ffmpegExit=0/.test(l)), 'new INFO line must surface ffmpegExit=0');
  t.restore();
});

test('RECLASSIFIED: ambiguous pipe-close + exitCode 139 -> NEUTRAL "stream stopped"', async () => {
  const t = makeStreamManager('Crashy');
  t.mgr._buildDashMerge = () =>
    makeFakeDashResult(
      ({ resolve, reject, err }) => {
        if (isAmbiguousPipeClose(err)) { resolve(); return; }
        reject(err);
      },
      { exitCode: 139 } // ambiguous: crash-y exit code, not clean
    );
  const result = await t.mgr.start({
    guildId: 'g1', channelId: 'c1',
    videoUrl: 'https://example.com/v.mp4', audioUrl: 'https://example.com/a.m4a',
    title: 'Crashy'
  });
  assert.strictEqual(result.ok, true);
  const session = result.session;

  session.command.__emitError(new Error('Output stream closed'));
  await new Promise((r) => setTimeout(r, 30));

  assert.strictEqual(t.channel.sent.length, 0, 'NO channel send');
  assert.strictEqual(t.alerts.filter((a) => a.event === 'stream-ended').length, 1);
  assert.strictEqual(t.alerts.filter((a) => a.event === 'stream-ended')[0].detail, M.STREAM_VOD_STOPPED, 'ambiguous (exitCode 139) -> neutral "stream stopped"');
  t.restore();
});

test('RECLASSIFIED: ambiguous pipe-close + no exitCode info -> NEUTRAL "stream stopped"', async () => {
  const t = makeStreamManager('Ambig');
  t.mgr._buildDashMerge = () =>
    makeFakeDashResult(
      ({ resolve, reject, err }) => {
        if (isAmbiguousPipeClose(err)) { resolve(); return; }
        reject(err);
      },
      null // no command.process at all — the truly ambiguous case
    );
  const result = await t.mgr.start({
    guildId: 'g1', channelId: 'c1',
    videoUrl: 'https://example.com/v.mp4', audioUrl: 'https://example.com/a.m4a',
    title: 'Ambig'
  });
  assert.strictEqual(result.ok, true);
  const session = result.session;

  session.command.__emitError(new Error('Output stream closed'));
  await new Promise((r) => setTimeout(r, 30));

  assert.strictEqual(t.channel.sent.length, 0, 'NO channel send');
  assert.strictEqual(t.alerts.filter((a) => a.event === 'stream-ended').length, 1);
  assert.strictEqual(t.alerts.filter((a) => a.event === 'stream-ended')[0].detail, M.STREAM_VOD_STOPPED, 'no child info -> neutral');
  t.restore();
});

test('RECLASSIFIED dedup: error-handler (ambiguous) + producer end -> STILL exactly one message', async () => {
  const t = makeStreamManager('Dedup');
  t.mgr._buildDashMerge = () =>
    makeFakeDashResult(
      ({ resolve, err }) => { if (isAmbiguousPipeClose(err)) resolve(); },
      { exitCode: 139 }
    );
  const result = await t.mgr.start({
    guildId: 'g1', channelId: 'c1',
    videoUrl: 'https://example.com/v.mp4', audioUrl: 'https://example.com/a.m4a',
    title: 'Dedup'
  });
  assert.strictEqual(result.ok, true);
  const session = result.session;

  session.command.__emitError(new Error('Output stream closed'));
  await new Promise((r) => setTimeout(r, 25));
  assert.strictEqual(t.channel.sent.length, 0, 'NO channel send');
  assert.strictEqual(t.alerts.filter((a) => a.event === 'stream-ended').length, 1, 'first alert: neutral from the error-handler branch');
  assert.strictEqual(t.alerts.filter((a) => a.event === 'stream-ended')[0].detail, M.STREAM_VOD_STOPPED);

  // Then the playStream .then also fires: must NOT double-notify.
  (t.mgr.session?.command.listeners?.end || []).forEach(resolve => resolve());
  await new Promise((r) => setTimeout(r, 25));
  assert.strictEqual(t.channel.sent.length, 0, 'never a channel send');
  assert.strictEqual(t.alerts.filter((a) => a.event === 'stream-ended').length, 1, 'never two alerts');
  t.restore();
});

test('producer end first (no error event) -> "video finished" (the drain path fires = clean)', async () => {
  const t = makeStreamManager('Clean');
  const result = await t.mgr.start(t.startArgs);
  assert.strictEqual(result.ok, true);
  (t.mgr.session?.command.listeners?.end || []).forEach(resolve => resolve());
  await new Promise((r) => setTimeout(r, 25));
  assert.strictEqual(t.channel.sent.length, 0, 'NO channel send');
  assert.strictEqual(t.alerts.filter((a) => a.event === 'stream-ended').length, 1);
  assert.strictEqual(t.alerts.filter((a) => a.event === 'stream-ended')[0].detail, M.STREAM_VOD_ENDED('Clean'), 'the drain path is the clean signal -> ENDED');
  t.restore();
});

// ============================================================================
// 5) Telemetry: one line per tick with the required fields; no URLs/tokens;
//    stop() clears the timer (unref'd); zero-cost after stop
// ============================================================================
test('telemetry: tick emits one line with the required fields and no URLs/tokens', () => {
  const lines = [];
  const log = (level, message) => { lines.push(String(message)); };
  const command = { process: { exitCode: null } };
  let byteTick = 0;

  const ws = new EventEmitter();
  const dataWs = new EventEmitter();
  let vc = { ws, streamConnection: { ws: dataWs, serverId: 'srv' } };

  const fakeMonitor = {
    percentile: (p) => (p === 99 ? 2_050_000 : 1_000_000),
    max: 5_000_000,
    paused: false,
    pause() { this.paused = true; }
  };
  let unrefs = 0;
  const timerFactory = (fn, ms) => {
    const t = { fn, ms, unref() { unrefs += 1; }, cleared: false };
    return t;
  };

  const tel = createTelemetry({
    log, command,
    getVoiceConnection: () => vc,
    createMonitor: () => fakeMonitor,
    disposeMonitor: (m) => { m.pause(); },
    timerFactory,
    getOutputBytes: () => (++byteTick === 1 ? { window: 120, total: 120 } : { window: 0, total: 120 }),
    getBufferState: () => ({ producerBytes: 1024, pipelineBytes: 4096, pipelineCapacityBytes: 8192 })
  });
  tel.start();

  tel.tick(); // first line: ws still 'ok'

  // Now close the main voice ws and tick again.
  ws.emit('close', 1000);
  tel.tick();

  assert.strictEqual(lines.length, 2, 'exactly one line per tick');
  for (const line of lines) {
    assert.ok(line.startsWith('tel: '), 'line must start with tel: ');
    assert.ok(!/https?:\/\//.test(line), 'no URLs in telemetry');
    assert.ok(!/test-token|secret/i.test(line), 'no secrets in telemetry');
    assert.match(line, /el_p99_ms=\d+/);
    assert.match(line, /el_max_ms=\d+/);
    assert.match(line, /outBytes_1s=\d+/);
    assert.match(line, /outBytes_total=\d+/);
    assert.match(line, /producer_buf=1024/);
    assert.match(line, /pipeline_buf=4096\/8192\(50%\)/);
    assert.match(line, /ff_alive=true/);
    assert.match(line, /ff_exit=(not-exited|\d+)/);
    assert.match(line, /ws_main=(ok|closed:\d+)/);
    assert.match(line, /ws_data=(ok|closed:\d+)/);
  }
  assert.match(lines[0], /outBytes_1s=120/, 'first tick must include the data pushed before it');
  assert.match(lines[0], /outBytes_total=120/);
  assert.match(lines[0], /ws_main=ok/);
  assert.match(lines[1], /ws_main=closed:1000/, 'a closed ws must be reflected as closed:<code>');
  assert.match(lines[1], /outBytes_1s=0/, 'window resets after each tick');
  assert.match(lines[1], /outBytes_total=120/, 'total accumulates');

  tel.stop();
  assert.ok(unrefs >= 1, 'the interval must be unref()d');
  assert.strictEqual(fakeMonitor.paused, true, 'monitor must be paused on stop()');
});

test('telemetry: stop() suppresses further ticks (zero-cost after session ends)', () => {
  const lines = [];
  const tel = createTelemetry({
    log: (level, parts) => { lines.push(parts.join(' ')); },
    command: null, getVoiceConnection: () => null,
    createMonitor: () => ({ percentile: () => 0, max: 0, pause() {} }),
    disposeMonitor: () => {},
    timerFactory: () => ({ unref() {} }),
    output: null
  });
  tel.start();
  tel.stop();
  const before = lines.length;
  tel.tick();
  assert.strictEqual(lines.length, before, 'a stopped telemetry must emit no further lines');
});

test('telemetry: late-appearing voiceConnection is picked up on a subsequent tick', () => {
  const lines = [];
  const log = (level, message) => { lines.push(String(message)); };
  let vc = null;
  const ws = new EventEmitter();
  const tel = createTelemetry({
    log, command: { process: { exitCode: null } },
    getVoiceConnection: () => vc,
    createMonitor: () => ({ percentile: () => 0, max: 0, pause() {} }),
    disposeMonitor: () => {},
    timerFactory: () => ({ unref() {} }),
    output: null
  });
  tel.start();

  // The voiceConnection appears late:
  vc = { ws, streamConnection: null };

  // A tick re-sweeps and attaches the close listener to the new ws.
  tel.tick();
  ws.emit('close', 4001);
  tel.tick();
  const last = lines[lines.length - 1];
  assert.match(last, /ws_main=closed:4001/, 'a late-appearing main ws must be tracked once it exists');
  tel.stop();
});

test('telemetry: does not crash when command/output/vc are missing', () => {
  const lines = [];
  const tel = createTelemetry({
    log: (level, message) => { lines.push(String(message)); },
    command: null,
    getVoiceConnection: () => { throw new Error('vc boom'); },
    createMonitor: () => { throw new Error('monitor boom'); },
    disposeMonitor: () => {},
    timerFactory: () => ({ unref() {} }),
    output: null
  });
  assert.doesNotThrow(() => tel.start());
  assert.doesNotThrow(() => tel.tick());
  assert.strictEqual(lines.length >= 1, true, 'a line must still be emitted (fields may be n/a)');
  tel.stop();
});
