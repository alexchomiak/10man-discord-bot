'use strict';

// 1 Hz per-session telemetry (see the "minimal 1 Hz telemetry" change).
// One INFO line per second, self-contained, zero-cost when stopped, unref'd so
// it never holds the process open. Captured fields only (no URLs/tokens/
// payloads):
//   el_p99_ms / el_max_ms   event-loop delay from monitorEventLoopDelay
//   outBytes_1s / _total    byte counts seen on the session output stream
//   rtcBytes_1s / _total    encoded bytes handed to a ready WebRTC transport
//   ff_alive / ff_exit      child process state (fluent ffmpegProc/process)
//   producer_buf            bytes queued before the NUT remuxer
//   pipeline_buf            bytes queued for Discord / configured capacity
//   ws_main / ws_data       last close code on the voice ws + the stream
//                           data ws ('ok' until a 'close' event lands)
const { monitorEventLoopDelay } = require('perf_hooks');

function createTelemetry(opts = {}) {
  const log = opts.log || ((...parts) => console.log('[streambot]', ...parts));
  const command = opts.command || null;
  const getVoiceConnection = typeof opts.getVoiceConnection === 'function' ? opts.getVoiceConnection : () => null;
  const getBufferState = typeof opts.getBufferState === 'function' ? opts.getBufferState : () => null;
  const getOutputBytes = typeof opts.getOutputBytes === 'function' ? opts.getOutputBytes : null;
  const getRtcBytes = typeof opts.getRtcBytes === 'function' ? opts.getRtcBytes : null;
  const createMonitor = opts.createMonitor || (() => {
    const m = monitorEventLoopDelay({ resolution: 20 });
    m.enable();
    return m;
  });
  const disposeMonitor = opts.disposeMonitor || ((m) => { try { m.disable(); } catch { /* ignore */ } });
  const now = opts.now || (() => performance.now());
  let progressAt = null;
  let frames = null;
  let previousFrames = null;
  let progressAttached = false;
  function onProgress(progress) {
    progressAt = now();
    if (Number.isFinite(progress?.frames)) frames = progress.frames;
  }
  const defaultTimerFactory = (fn, ms) => { const t = setInterval(fn, ms); t.unref(); return t; };
  // If a custom timerFactory is supplied (tests), the default is still used as
  // the underlying implementation — we wrap it so the contract (timer is
  // unref'd) is guaranteed regardless of what the caller returns.
  const rawTimerFactory = opts.timerFactory || defaultTimerFactory;
  const timerFactory = (fn, ms) => {
    const t = rawTimerFactory(fn, ms);
    if (t && typeof t.unref === 'function') {
      try { t.unref(); } catch { /* not a Node Timer — no-op */ }
    }
    return t;
  };

  const tagged = new WeakSet();
  const wsState = { main: 'ok', data: 'ok' };
  let outBytesWindow = 0;
  let outBytesTotal = 0;
  let rtcBytesWindow = 0;
  let rtcBytesTotal = 0;
  let previousRtcBytes = null;
  let monitor = null;
  let interval = null;
  let stopped = false;

  function attachWsOnce(ws, key) {
    if (!ws || tagged.has(ws)) return;
    tagged.add(ws);
    try {
      ws.on('close', (code) => { wsState[key] = `closed:${code === undefined ? 'unknown' : code}`; });
      ws.on('error', (e) => { log('info', `tel: ws_${key} error: ${e && e.name}`); });
    } catch { /* object not an EventEmitter — skip */ }
  }

  // Re-check each tick: voiceConnection / its ws can appear late (post-join)
  // or be re-created — attach only to objects we haven't tagged yet.
  function sweepVoiceWs() {
    let vc = null;
    try { vc = getVoiceConnection(); } catch { return; }
    if (!vc) return;
    let main = null; let data = null;
    try { main = vc.ws; } catch { /* ignore */ }
    try { data = vc.streamConnection && vc.streamConnection.ws; } catch { /* ignore */ }
    attachWsOnce(main, 'main');
    attachWsOnce(data, 'data');
  }

  function ffState() {
    let child = null; let exitCode;
    try { child = command && (command.ffmpegProc || command.process); } catch { child = null; }
    try { exitCode = child ? child.exitCode : null; } catch { exitCode = null; }
    const alive = !!(child && child.exitCode === null);
    return { alive, exitCode };
  }

  function tick() {
    if (stopped) return;
    // Lazy re-sweep: voiceConnection / its ws can appear late (post-join).
    sweepVoiceWs();
    let p99 = null; let max = null;
    try {
      if (monitor && typeof monitor.percentile === 'function') {
        p99 = Math.round(monitor.percentile(99) / 1e6);
        max = Math.round(monitor.max / 1e6);
        monitor.reset?.();
      }
    } catch { /* monitor not ready */ }
    const { alive, exitCode } = ffState();
    let buffers = null;
    try { buffers = getBufferState(); } catch { buffers = null; }
    if (getOutputBytes) {
      try {
        const counts = getOutputBytes();
        if (Number.isFinite(counts?.window)) outBytesWindow = counts.window;
        if (Number.isFinite(counts?.total)) outBytesTotal = counts.total;
      } catch { /* keep the last safe counters */ }
    }
    if (getRtcBytes) {
      try {
        const current = getRtcBytes();
        if (Number.isFinite(current) && current >= 0) {
          rtcBytesWindow = previousRtcBytes === null || current < previousRtcBytes
            ? 0
            : current - previousRtcBytes;
          rtcBytesTotal = current;
          previousRtcBytes = current;
        }
      } catch { rtcBytesWindow = 0; }
    }
    const producerBytes = Number.isFinite(buffers?.producerBytes) ? buffers.producerBytes : 0;
    const pipelineBytes = Number.isFinite(buffers?.pipelineBytes) ? buffers.pipelineBytes : 0;
    const pipelineCapacityBytes = Number.isFinite(buffers?.pipelineCapacityBytes) ? buffers.pipelineCapacityBytes : 0;
    const fillPct = pipelineCapacityBytes > 0 ? Math.round(pipelineBytes * 100 / pipelineCapacityBytes) : 0;
    const frameDelta = frames === null || previousFrames === null ? 'n/a' : Math.max(0, frames - previousFrames);
    previousFrames = frames;
    const line =
      `tel: ` +
      `el_p99_ms=${p99 === null ? 'n/a' : p99} ` +
      `el_max_ms=${max === null ? 'n/a' : max} ` +
      `outBytes_1s=${outBytesWindow} outBytes_total=${outBytesTotal} ` +
      `rtcBytes_1s=${rtcBytesWindow} rtcBytes_total=${rtcBytesTotal} ` +
      `producer_buf=${producerBytes} pipeline_buf=${pipelineBytes}/${pipelineCapacityBytes}(${fillPct}%) ` +
      `ff_alive=${alive} ff_exit=${exitCode === null ? 'not-exited' : exitCode} ` +
      `ff_frames=${frames ?? 'n/a'} ff_frames_1s=${frameDelta} ` +
      `ff_progress_age_ms=${progressAt === null ? 'n/a' : Math.round(Math.max(0, now() - progressAt))} ` +
      `ws_main=${wsState.main} ws_data=${wsState.data}`;
    try { log('info', line); } catch { /* logger gone */ }
    outBytesWindow = 0;
    rtcBytesWindow = 0;
  }

  function start() {
    if (interval) return; // idempotent
    stopped = false;
    if (!progressAttached && typeof command?.on === 'function') {
      command.on('progress', onProgress);
      progressAttached = true;
    }
    try { monitor = createMonitor(); } catch { monitor = null; }
    sweepVoiceWs();
    interval = timerFactory(tick, 1000);
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (progressAttached) {
      command.removeListener('progress', onProgress);
      progressAttached = false;
    }
    if (interval) {
      try { clearInterval(interval); } catch { /* ignore */ }
      interval = null;
    }
    if (monitor) {
      disposeMonitor(monitor);
      monitor = null;
    }
  }

  return { start, stop, tick, _state: { wsState, tagged, interval: () => interval, monitor: () => monitor } };
}

module.exports = { createTelemetry };
