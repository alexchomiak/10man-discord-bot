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

test('preparePlayback: VAAPI preflight selects the first render node that actually encodes', async () => {
  const mgr = new StreamManager({ token: 't' }, 'c1', {
    videoEncoder: 'vaapi', vaapiDevice: '/dev/dri/renderD128'
  });
  const checked = [];
  mgr._vaapiCandidates = () => ['/dev/dri/renderD128', '/dev/dri/renderD129'];
  mgr._probeVaapiDevice = async device => {
    checked.push(device);
    return device.endsWith('129') ? { ok: true } : { ok: false, detail: 'Device creation failed' };
  };
  await mgr.preparePlayback({});
  assert.deepStrictEqual(checked, ['/dev/dri/renderD128', '/dev/dri/renderD129']);
  assert.equal(mgr.config.vaapiDevice, '/dev/dri/renderD129');
  await mgr.preparePlayback({});
  assert.equal(checked.length, 2, 'successful probe is cached for the worker lifetime');
});

test('preparePlayback: VAAPI preflight refuses playback when no render node works', async () => {
  const mgr = new StreamManager({ token: 't' }, 'c1', {
    videoEncoder: 'vaapi', vaapiDevice: '/dev/dri/renderD128'
  });
  mgr._vaapiCandidates = () => ['/dev/dri/renderD128'];
  mgr._probeVaapiDevice = async () => ({ ok: false, detail: 'permission denied' });
  await assert.rejects(() => mgr.preparePlayback({}), /VAAPI H\.264 initialization failed.*permission denied/);
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

test('progress filter is absent by default and unknown/live media keep VAAPI frames on device', () => {
  const config = { videoCodec: 'H264', videoEncoder: 'vaapi', hardwareDecode: true,
    vaapiDevice: '/dev/dri/renderD128', streamWidth: 1920, streamHeight: 1080 };
  const mgr = new StreamManager({ token: 't' }, 'c1', config);
  const videoModule = { Utils: { normalizeVideoCodec: c => c } };
  const command = piece => mgr._buildDashMerge(videoModule, 'https://cdn.example/v.mp4',
    'https://cdn.example/a.m4a', 0, null, piece).command;
  const finite = { totalDurationSec: 3600, isLive: false };
  const off = argvOf(command(finite));
  assert(off.some(arg => arg.includes('scale_vaapi=') && arg.includes('pad_vaapi=')));
  assert(!off.some(arg => arg.includes('hwdownload') || arg.includes('geq=') || arg.includes('drawtext=')));
  mgr.progressOverlay = true;
  const unknown = argvOf(command({ isLive: false }));
  const live = argvOf(command({ totalDurationSec: 3600, isLive: true }));
  for (const args of [unknown, live]) {
    assert(!args.some(arg => arg.includes('hwdownload') || arg.includes('geq=')));
  }
  const on = argvOf(command(finite));
  const filter = on.find(arg => arg.includes('geq='));
  assert(filter);
  assert.match(filter, /scale_vaapi=.*pad_vaapi=.*hwdownload,format=nv12,split/);
  assert.match(filter, /geq=.*overlay=.*drawtext=.*format=nv12,hwupload/);
});

test('toggling progress restarts finite VOD at its current position before queued media', async () => {
  const mgr = new StreamManager({ token: 't' }, 'c1');
  const queued = { title: 'next' };
  const link = { paused: false, pipeline: { enqueue: [queued], writerTask: Promise.resolve() } };
  const active = { title: 'current', isLive: false, totalDurationSec: 3600,
    startOffsetSec: 1800, playedSec: 12, voiceLink: link };
  link.pipeline.activeWriter = active;
  mgr.voiceLink = link;
  mgr.session = active;
  let cancelled = false;
  mgr._cancelPiece = () => { cancelled = true; };
  mgr._reopenSession = (_link, _session, args) => ({ title: 'current', startOffsetSec: args.offsetSec });
  const result = await mgr.toggleProgressOverlay();
  assert.equal(result.enabled, true);
  assert.equal(result.restarted, true);
  assert.equal(cancelled, true);
  assert.equal(link.pipeline.enqueue[0].title, 'current');
  assert.equal(link.pipeline.enqueue[0].startOffsetSec, 1812);
  assert.strictEqual(link.pipeline.enqueue[1], queued);
  link.paused = true;
  const pausedResult = await mgr.toggleProgressOverlay();
  assert.equal(pausedResult.enabled, false);
  assert.equal(pausedResult.restarted, false);
});

test('dash merge: VOD inputs read at realtime after a startup burst', () => {
  const command = buildDashCommand({ offset: 0 });
  const argv = argvOf(command);
  const inputs = argv.filter((a) => a === '-i').length;
  assert.strictEqual(inputs, 2, 'dash merge must keep exactly two -i inputs');

  assert.strictEqual(argv.filter((a) => a === '-re').length, 0, 'TimedTrack owns pacing; HTTP inputs must refill the buffer');
  assert.strictEqual(argv.filter((a) => a === '-readrate').length, 2, 'each YouTube DASH input must be paced');
  assert.deepStrictEqual(argv.flatMap((a, i) => a === '-readrate' ? [argv[i + 1]] : []), ['1.15', '1.15'],
    'each DASH input needs catch-up headroom after a stall');
  assert.deepStrictEqual(argv.flatMap((a, i) => a === '-thread_queue_size' ? [argv[i + 1]] : []), ['256', '256'],
    'VOD input queues must remain bounded');
  assert.strictEqual(argv.filter((a) => a === '-readrate_initial_burst').length, 2);
  assert.strictEqual(argv.filter((a) => a === '-thread_queue_size').length, 2);
  assert.strictEqual(argv.filter((a) => a === '-rw_timeout').length, 2);
  assert.strictEqual(argv.filter((a) => a === '-reconnect').length, 2);

  assert.ok(!argv.includes('-ss'), 'no -ss without an offset');
});

test('dash merge: with offset, ONE -ss per network input and no duplicate pacing', () => {
  const command = buildDashCommand({ offset: 60 });
  const argv = argvOf(command);
  assert.strictEqual(argv.filter((a) => a === '-i').length, 2, 'still two inputs');
  assert.strictEqual(argv.filter((a) => a === '-ss').length, 2, 'one -ss per input, not duplicated');
  assert.strictEqual(argv.filter((a) => a === '60').length, 2, 'offset value appears per input');
  assert.strictEqual(argv.filter((a) => a === '-re').length, 0);
});

test('finite split VOD avoids shortest synchronization and infinite audio padding', () => {
  for (const piece of [null, { isLive: false }]) {
    const argv = argvOf(buildDashCommand({ piece }));
    assert.ok(!argv.includes('-shortest'), 'shortest stalls independently paced VOD inputs on FFmpeg 7.1');
    assert.ok(!argv.some(a => /\bapad\b/.test(a)), 'finite VOD must reach natural EOF without endless silence');
  }
});

test('YouTube HLS permits extensionless segments only on its manifest host', () => {
  const mgr = new StreamManager({ token: 't' }, 'c1', {});
  for (const host of ['manifest.googlevideo.com', 'manifest.googlevideo.com.evil.example']) {
    const url = `https://${host}/api/manifest/hls_playlist/audio/index.m3u8`;
    const result = mgr._buildDashMerge({ Utils: { normalizeVideoCodec: c => c } }, url, null, 3600, null, { isLive: false });
    const argv = argvOf(result.command);
    assert.equal(argv.includes('-extension_picky'), host === 'manifest.googlevideo.com');
    assert.ok(argv.includes('3600'), 'HLS VOD seeking is retained');
    assert.ok(!argv.includes('-reconnect_at_eof'), 'finite playlist must reach EOF');
  }
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
  assert.ok(argvOf(command).includes('-shortest'));
  assert.ok(argvOf(command).some(a => /\bapad\b/.test(a)));
});

test('combined VOD uses only its own A/V input and cannot queue behind realtime silence', () => {
  const mgr = new StreamManager({ token: 't' }, 'c1', {
    videoCodec: 'H264', streamBitrate: 5000, streamHeight: 1080,
    streamFrameRate: 30, streamAudioBitrate: 128
  });
  const command = StreamManager.prototype._buildDashMerge.call(
    mgr,
    { Utils: { normalizeVideoCodec: (c) => c } },
    'https://jellyfin.example/movie.mp4',
    null,
    0,
    null,
    { isLive: false }
  ).command;
  const argv = argvOf(command);
  assert.strictEqual(argv.filter((a) => a === '-i').length, 1,
    'combined media must not add a synthetic realtime audio input');
  assert.ok(!argv.some((a) => a.includes('anullsrc')));
  assert.strictEqual(argv.filter((a) => a === '-map').length, 2,
    'combined media must emit exactly one video and one audio mapping');
  assert.ok(argv.includes('0:a:0?'));
  assert.ok(!argv.includes('-shortest'));
  assert.ok(!argv.some(a => /\bapad\b/.test(a)));
  assert.deepStrictEqual(argv.slice(argv.indexOf('-pix_fmt'), argv.indexOf('-pix_fmt') + 2),
    ['-pix_fmt', 'yuv420p']);
});

test('Arc mode uses VAAPI encode with the configured render device and 1080p/30 rate control', () => {
  const mgr = new StreamManager({ token: 't' }, 'c1', {
    videoCodec: 'H264', videoEncoder: 'vaapi', vaapiDevice: '/dev/dri/renderD129',
    streamWidth: 1920, streamHeight: 1080, streamFrameRate: 30,
    streamBitrate: 5000, streamAudioBitrate: 128, pipelineBufferMb: 8
  });
  const videoModule = { Utils: { normalizeVideoCodec: (c) => c } };
  const command = StreamManager.prototype._buildDashMerge.call(
    mgr, videoModule, 'https://cdn.example/v.mp4', 'https://cdn.example/a.m4a', 0, null, {}
  ).command;
  const argv = argvOf(command);
  assert.ok(argv.includes('h264_vaapi'));
  assert.ok(!argv.includes('-pix_fmt'), 'VAAPI input must remain hardware surfaces');
  assert.ok(argv.includes('/dev/dri/renderD129'));
  assert.ok(argv.includes('scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,format=nv12,hwupload'));
  assert.deepStrictEqual(argv.slice(argv.indexOf('-r'), argv.indexOf('-r') + 2), ['-r', '30']);
  assert.ok(argv.includes('7000k'));
  assert.ok(argv.includes('1500k'));
  assert.deepStrictEqual(argv.slice(argv.indexOf('-profile:v'), argv.indexOf('-profile:v') + 2), ['-profile:v', 'constrained_baseline']);
  assert.deepStrictEqual(argv.slice(argv.indexOf('-level:v'), argv.indexOf('-level:v') + 2), ['-level:v', '4.1']);
  assert.deepStrictEqual(argv.slice(argv.indexOf('-g'), argv.indexOf('-g') + 2), ['-g', '60']);
  assert.deepStrictEqual(argv.slice(argv.indexOf('-keyint_min'), argv.indexOf('-keyint_min') + 2), ['-keyint_min', '60']);
  assert.deepStrictEqual(argv.slice(argv.indexOf('-idr_interval'), argv.indexOf('-idr_interval') + 2), ['-idr_interval', '0']);
  assert.deepStrictEqual(argv.slice(argv.indexOf('-bufsize:v'), argv.indexOf('-bufsize:v') + 2), ['-bufsize:v', '1500k']);
  assert.deepStrictEqual(argv.slice(argv.indexOf('-force_key_frames'), argv.indexOf('-force_key_frames') + 2),
    ['-force_key_frames', 'expr:gte(t,n_forced*2)']);
});

test('Arc hardware decode keeps decode, aspect-correct scale, pad and encode on VAAPI', () => {
  const mgr = new StreamManager({ token: 't' }, 'c1', {
    videoCodec: 'H264', videoEncoder: 'vaapi', hardwareDecode: true,
    vaapiDevice: '/dev/dri/renderD129', streamWidth: 1920, streamHeight: 1080,
    streamFrameRate: 30, streamBitrate: 5000, streamAudioBitrate: 128
  });
  const command = StreamManager.prototype._buildDashMerge.call(
    mgr,
    { Utils: { normalizeVideoCodec: (c) => c } },
    'https://cdn.example/v.mp4', 'https://cdn.example/a.m4a', 0, null, {}
  ).command;
  const argv = argvOf(command);
  assert.deepStrictEqual(argv.slice(argv.indexOf('-hwaccel'), argv.indexOf('-hwaccel') + 6),
    ['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD129', '-hwaccel_output_format', 'vaapi']);
  assert.ok(argv.includes('scale_vaapi=w=1920:h=1080:force_original_aspect_ratio=decrease:force_divisible_by=2:format=nv12,pad_vaapi=w=1920:h=1080:x=(ow-iw)/2:y=(oh-ih)/2'));
  assert.ok(!argv.includes('-pix_fmt'), 'hardware-decoded VAAPI frames must remain hardware surfaces');
  assert.ok(!argv.includes('format=nv12,hwupload'), 'hardware frames must not make a GPU -> CPU -> GPU round trip');
});

test('live Arc input automatically deinterlaces on GPU and emits constant 30fps', () => {
  const mgr = new StreamManager({ token: 't' }, 'c1', {
    videoCodec: 'H264', videoEncoder: 'vaapi', hardwareDecode: true,
    vaapiDevice: '/dev/dri/renderD128', streamWidth: 1920, streamHeight: 1080,
    streamFrameRate: 30, streamBitrate: 5000, streamAudioBitrate: 128
  });
  const command = StreamManager.prototype._buildDashMerge.call(
    mgr, { Utils: { normalizeVideoCodec: c => c } },
    'https://tv.example/live.ts', null, 0, null, { isLive: true }
  ).command;
  const argv = argvOf(command);
  assert.ok(argv.includes('deinterlace_vaapi=mode=motion_adaptive:rate=frame:auto=1,scale_vaapi=w=1920:h=1080:force_original_aspect_ratio=decrease:force_divisible_by=2:format=nv12,pad_vaapi=w=1920:h=1080:x=(ow-iw)/2:y=(oh-ih)/2'));
  assert.ok(argv.includes('-shortest'));
  assert.ok(argv.some(a => /\bapad\b/.test(a)));
  assert.deepStrictEqual(argv.slice(argv.indexOf('-fps_mode'), argv.indexOf('-fps_mode') + 2), ['-fps_mode', 'cfr']);
  assert.deepStrictEqual(argv.slice(argv.indexOf('-reconnect_at_eof'), argv.indexOf('-reconnect_at_eof') + 2),
    ['-reconnect_at_eof', '1'], 'live HTTP inputs must reconnect after a clean proxy EOF');
});

test('video burst controls are configurable without reducing average or peak bitrate', () => {
  const mgr = new StreamManager({ token: 't' }, 'c1', {
    videoCodec: 'H264', streamBitrate: 6000, streamVbvBufferKbps: 2400,
    keyframeIntervalSec: 1.5, streamHeight: 1080, streamFrameRate: 30,
    streamAudioBitrate: 128
  });
  const command = StreamManager.prototype._buildDashMerge.call(
    mgr,
    { Utils: { normalizeVideoCodec: (c) => c } },
    'https://cdn.example/v.mp4', 'https://cdn.example/a.m4a', 0, null, {}
  ).command;
  const argv = argvOf(command);
  assert.deepStrictEqual(argv.slice(argv.indexOf('-b:v'), argv.indexOf('-b:v') + 2), ['-b:v', '6000k']);
  assert.deepStrictEqual(argv.slice(argv.indexOf('-maxrate:v'), argv.indexOf('-maxrate:v') + 2), ['-maxrate:v', '8400k']);
  assert.deepStrictEqual(argv.slice(argv.indexOf('-bufsize:v'), argv.indexOf('-bufsize:v') + 2), ['-bufsize:v', '2400k']);
  assert.deepStrictEqual(argv.slice(argv.indexOf('-force_key_frames'), argv.indexOf('-force_key_frames') + 2),
    ['-force_key_frames', 'expr:gte(t,n_forced*1.5)']);
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

test('live EOF retries on the existing voice link instead of reporting VOD ended', async () => {
  const t = makeStreamManager('Live channel');
  try {
    const result = await t.mgr.start({ ...t.startArgs, isLive: true });
    assert.equal(result.ok, true);
    const link = t.mgr.voiceLink;
    (result.session.command.listeners.end || []).forEach(resolve => resolve());
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.strictEqual(t.mgr.voiceLink, link);
    assert.equal(link.pipeline.activeWriter?.recoveryAttempt, 1);
    assert.equal(t.alerts.filter(a => a.event === 'stream-ended').length, 0);
    assert.equal(link.graceTimer, null);
    await t.mgr.stop();
  } finally {
    t.restore();
  }
});

test('manager avoids VOD sync waits while retaining live track sync', async () => {
  for (const isLive of [false, true]) {
    const t = makeStreamManager(isLive ? 'Live source' : 'VOD source');
    let syncVideoToAudio;
    t.mgr._feederFactory = () => ({
      start: async () => ({}),
      append: async (_output, _signal, _onVideoFrame, options) => {
        syncVideoToAudio = options.syncVideoToAudio;
      },
      interrupt() {}, close: async () => {}
    });
    try {
      const result = await t.mgr.start({ ...t.startArgs, isLive });
      assert.equal(result.ok, true);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(syncVideoToAudio, isLive);
      await t.mgr.stop();
    } finally {
      t.restore();
    }
  }
});

test('live recovery resolves a fresh URL before reopening the source', async () => {
  const t = makeStreamManager('Scheduled live channel');
  const sources = require('../src/streambot/sources');
  const originalResolve = sources.resolveSource;
  const inputs = [];
  sources.resolveSource = async input => {
    inputs.push(input);
    return { available: true, isLive: true, streamUrl: 'https://example.com/fresh.ts' };
  };
  try {
    const result = await t.mgr.start({ ...t.startArgs, isLive: true, sourceInput: 'scheduled-share' });
    assert.equal(result.ok, true);
    (result.session.command.listeners.end || []).forEach(resolve => resolve());
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.deepStrictEqual(inputs, ['scheduled-share']);
    assert.equal(t.mgr.voiceLink?.pipeline?.activeWriter?.streamUrl, 'https://example.com/fresh.ts');
    assert.equal(t.alerts.filter(a => a.event === 'stream-ended').length, 0);
    await t.mgr.stop();
  } finally {
    sources.resolveSource = originalResolve;
    t.restore();
  }
});

test('VOD audio/video sync failure reopens both tracks without reporting completion', async () => {
  const t = makeStreamManager('YouTube VOD');
  t.mgr._feederFactory = () => ({
    start: async () => ({}),
    append: async () => { const error = new Error('Audio/video synchronization lost'); error.code = 'AV_SYNC_LOST'; throw error; },
    interrupt() {}, close: async () => {}
  });
  try {
    const result = await t.mgr.start({ ...t.startArgs, sourceInput: 'https://www.youtube.com/watch?v=test', totalDurationSec: 1200 });
    assert.equal(result.ok, true);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(t.mgr.voiceLink?.pipeline?.activeWriter?.recoveryAttempt, 1);
    assert.equal(t.alerts.filter(a => a.event === 'stream-ended').length, 0);
    await t.mgr.stop();
  } finally {
    t.restore();
  }
});

test('premature VOD EOF resumes from sent video time, not stalled wall time', async () => {
  const t = makeStreamManager('Long YouTube VOD');
  try {
    const result = await t.mgr.start({ ...t.startArgs,
      sourceInput: 'https://www.youtube.com/watch?v=test', totalDurationSec: 7200 });
    assert.equal(result.ok, true);
    result.session.playedSec = 12;
    result.session.startedAt = Date.now() - 10 * 60 * 1000;
    assert.equal(Math.round(t.mgr.positionOf(result.session)), 12);
    (result.session.command.listeners.end || []).forEach(resolve => resolve());
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(t.mgr.voiceLink?.pipeline?.activeWriter?.startOffsetSec, 12);
    assert.equal(t.alerts.filter(a => a.event === 'stream-ended').length, 0);
    await t.mgr.stop();
  } finally {
    t.restore();
  }
});

test('VOD frame stall reopens the source instead of freezing indefinitely', async () => {
  const t = makeStreamManager('Stalled YouTube VOD');
  t.mgr.config.vodStallTimeoutMs = 40;
  t.mgr._feederFactory = () => ({
    start: async () => ({}),
    append: async (_input, signal, onVideoFrame) => {
      onVideoFrame(1000 / 30);
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
    interrupt() {}, close: async () => {}
  });
  try {
    const result = await t.mgr.start({ ...t.startArgs,
      sourceInput: 'https://www.youtube.com/watch?v=test', totalDurationSec: 7200 });
    assert.equal(result.ok, true);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(t.mgr.voiceLink?.pipeline?.activeWriter?.recoveryAttempt, 1);
    assert.equal(t.alerts.filter(a => a.event === 'stream-ended').length, 0);
    await t.mgr.stop();
  } finally {
    t.restore();
  }
});

test('VOD stall watchdog does not restart the source while WebRTC is disconnected', async () => {
  const t = makeStreamManager('Disconnected viewer');
  t.mgr.config.vodStallTimeoutMs = 40;
  t.mgr._feederFactory = () => ({
    connection: { ready: false },
    start: async () => ({}),
    append: async (_input, signal, onVideoFrame) => {
      onVideoFrame(1000 / 30);
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
    interrupt() {}, close: async () => {}
  });
  try {
    const result = await t.mgr.start({ ...t.startArgs,
      sourceInput: 'https://www.youtube.com/watch?v=test', totalDurationSec: 7200 });
    assert.equal(result.ok, true);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(t.mgr.voiceLink?.pipeline?.activeWriter?.recoveryAttempt, undefined);
    await t.mgr.stop();
  } finally {
    t.restore();
  }
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
  let rtcBytes = 1000;

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
    getRtcBytes: () => { rtcBytes += 500; return rtcBytes; },
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
    assert.match(line, /rtcBytes_1s=\d+/);
    assert.match(line, /rtcBytes_total=\d+/);
    assert.match(line, /producer_buf=1024/);
    assert.match(line, /pipeline_buf=4096\/8192\(50%\)/);
    assert.match(line, /ff_alive=true/);
    assert.match(line, /ff_exit=(not-exited|\d+)/);
    assert.match(line, /ws_main=(ok|closed:\d+)/);
    assert.match(line, /ws_data=(ok|closed:\d+)/);
  }
  assert.match(lines[0], /outBytes_1s=120/, 'first tick must include the data pushed before it');
  assert.match(lines[0], /outBytes_total=120/);
  assert.match(lines[0], /rtcBytes_1s=0/);
  assert.match(lines[0], /rtcBytes_total=1500/);
  assert.match(lines[0], /ws_main=ok/);
  assert.match(lines[1], /ws_main=closed:1000/, 'a closed ws must be reflected as closed:<code>');
  assert.match(lines[1], /outBytes_1s=0/, 'window resets after each tick');
  assert.match(lines[1], /outBytes_total=120/, 'total accumulates');
  assert.match(lines[1], /rtcBytes_1s=500/, 'native WebRTC bytes must report transport progress');
  assert.match(lines[1], /rtcBytes_total=2000/);

  tel.stop();
  assert.ok(unrefs >= 1, 'the interval must be unref()d');
  assert.strictEqual(fakeMonitor.paused, true, 'monitor must be paused on stop()');
});

test('telemetry: real event-loop monitor and encoder progress survive a producer stall', async () => {
  const command = new EventEmitter();
  const lines = [];
  let now = 0;
  const tel = createTelemetry({ command, now: () => now,
    log: (_level, line) => lines.push(line),
    timerFactory: () => ({ unref() {} }) });
  try {
    tel.start();
    await new Promise(resolve => setTimeout(resolve, 60));
    command.emit('progress', { frames: 100, timemark: 'secret-ignored' });
    tel.tick();
    now = 2000;
    tel.tick();
    assert.match(lines[0], /el_p99_ms=\d+ el_max_ms=\d+/);
    assert.match(lines[1], /ff_frames=100 ff_frames_1s=0 ff_progress_age_ms=2000/);
    assert.ok(!lines[1].includes('secret-ignored'));
    command.emit('progress', { frames: 130 });
    tel.tick();
    assert.match(lines[2], /ff_frames=130 ff_frames_1s=30 ff_progress_age_ms=0/);
  } finally { tel.stop(); }
  assert.equal(command.listenerCount('progress'), 0);
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

test('telemetry separates track handoff gaps and signed media timestamp skew', () => {
  const lines = [];
  const tel = createTelemetry({ log: (_level, line) => lines.push(line),
    getTrackDiagnostics: () => ({
      video: { frames: 0, bytes: 0, maxGapMs: 2000, ageMs: 2000, resets: 1, lastPts: 1000, keyAgeMs: 4000 },
      audio: { frames: 50, bytes: 16000, maxGapMs: 21, ageMs: 5, resets: 0, lastPts: 2900 }
    }) });
  tel.tick();
  assert.match(lines[0], /v_frames=0 v_bytes=0 v_gap_ms=2000 v_age_ms=2000 v_clock_resets=1/);
  assert.match(lines[0], /a_frames=50 a_bytes=16000 a_gap_ms=21/);
  assert.match(lines[0], /av_sent_pts_ms=-1900 v_key_age_ms=4000/);
  tel.stop();
});
