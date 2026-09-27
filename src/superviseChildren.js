'use strict';

const { spawn } = require('node:child_process');

// Keep each process independent. A failed worker backs off before restarting;
// a healthy sibling is never stopped because another worker failed.
function superviseChildren(specs, { label = 'supervisor', baseDelayMs = 1000, maxDelayMs = 30000,
  heartbeatIntervalMs = 15000, heartbeatTimeoutMs = 90000 } = {}) {
  require('./processHeartbeat');
  const states = specs.map(spec => ({ spec, child: null, timer: null, heartbeat: null, failures: 0, startedAt: 0 }));
  let stopping = false;

  function signalTree(child, signal) {
    if (!child?.pid) return;
    if (process.platform !== 'win32') {
      try { process.kill(-child.pid, signal); return; } catch { /* already gone */ }
    }
    try { child.kill(signal); } catch { /* already gone */ }
  }

  function launch(state) {
    if (stopping) return;
    const { spec } = state;
    state.startedAt = Date.now();
    const child = spawn(process.execPath, [spec.script], {
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      detached: process.platform !== 'win32',
      env: { ...process.env, ...spec.env }
    });
    state.child = child;
    let lastPong = Date.now();
    let terminationReason = 'child-exit';
    child.on('message', message => { if (message === 'supervisor:pong') lastPong = Date.now(); });
    state.heartbeat = setInterval(() => {
      if (Date.now() - lastPong > heartbeatTimeoutMs) {
        terminationReason = 'heartbeat-timeout';
        console.error(`[${label}] ${spec.name} stopped responding; restarting`);
        signalTree(child, 'SIGKILL');
        return;
      }
      try {
        child.send('supervisor:ping', error => {
          if (error) { terminationReason = 'heartbeat-send-error'; signalTree(child, 'SIGKILL'); }
        });
      } catch { terminationReason = 'heartbeat-send-error'; signalTree(child, 'SIGKILL'); }
    }, heartbeatIntervalMs);
    let finished = false;
    const restart = (code, signal, error) => {
      if (finished) return;
      finished = true;
      clearInterval(state.heartbeat);
      state.heartbeat = null;
      // Reap subprocesses such as FFmpeg even if the Node worker died first.
      signalTree(child, 'SIGKILL');
      state.child = null;
      if (stopping) return;
      if (Date.now() - state.startedAt >= 60000) state.failures = 0;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(state.failures++, 10));
      console.error(`[${label}] ${spec.name} exited code=${code ?? 'none'} signal=${signal || 'none'} reason=${terminationReason} uptime_ms=${Date.now() - state.startedAt} last_pong_age_ms=${Date.now() - lastPong}${error ? ` error=${error.message}` : ''}; restarting in ${delay}ms`);
      state.timer = setTimeout(() => {
        state.timer = null;
        launch(state);
      }, delay);
    };
    child.once('error', error => restart(null, null, error));
    child.once('exit', (code, signal) => restart(code, signal));
    console.log(`[${label}] started ${spec.name} pid=${child.pid || 'pending'}`);
  }

  function shutdown(signal = 'SIGTERM') {
    if (stopping) return;
    stopping = true;
    for (const state of states) {
      clearTimeout(state.timer);
      state.timer = null;
      clearInterval(state.heartbeat);
      state.heartbeat = null;
      if (state.child && state.child.exitCode === null && state.child.signalCode === null) {
        signalTree(state.child, signal);
      }
    }
    const deadline = setTimeout(() => {
      for (const state of states) {
        if (state.child && state.child.exitCode === null && state.child.signalCode === null) {
          signalTree(state.child, 'SIGKILL');
        }
      }
      process.exit(0);
    }, 5000);
    deadline.unref();
    Promise.all(states.map(state => state.child && state.child.exitCode === null && state.child.signalCode === null
      ? new Promise(resolve => state.child.once('exit', resolve)) : Promise.resolve()))
      .finally(() => { clearTimeout(deadline); process.exit(0); });
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  for (const state of states) launch(state);
  return { shutdown };
}

module.exports = { superviseChildren };
