'use strict';

function clampInt(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  let v = Math.floor(value);
  if (v < min) v = min;
  if (max != null && v > max) v = max;
  return v;
}

// Watches a native PeerConnection's monotonic bytesSent() counter against the
// feed rate to detect a stuck send queue (the unbounded libdatachannel
// send-queue growth). Pure JS, clock- and timer-injectable so it is fully
// unit-testable with a fake PC; it never imports the library, reads fs, or
// opens sockets. See design: src/streambot/sendSupervisor.js (Agent 4).
//
// Recycle semantics (Agent 6): a single supervisor instance is REUSED across
// recycles for one active link. onStall #n -> recycle (rejoin) -> onStall
// #n+1 must be able to fire again, and >recycleMax recycles within
// recycleWindowSec must escalate to onFatal. The latch (state) and the
// baselines (lastBytes / zeroTicks / feedWindow) are the two things that, if
// left stale, would block that: resetBaseline() re-arms them on every rejoin
// while PRESERVING recycleStamps (the escalation count), so the same
// instance can re-fire onStall and eventually escalate.
function createSendSupervisor(options = {}) {
  // getPC / onStall / onFatal are bound dynamically by the owner (the
  // manager passes closures that read the CURRENT live link, so they track
  // rejoins for free). The supervisor never captures a link object itself.
  const getPC = typeof options.getPC === 'function' ? options.getPC : () => null;
  const onStall = typeof options.onStall === 'function' ? options.onStall : () => {};
  const onFatal = typeof options.onFatal === 'function' ? options.onFatal : () => {};
  const inject = options.config || {};

  const stallSec = clampInt(inject.stallSec, 5, 1, Infinity);
  const recycleMax = clampInt(inject.recycleMax, 3, 1, Infinity);
  const recycleWindowMs = clampInt(inject.recycleWindowSec, 600, 10, Infinity) * 1000;
  const fatalErrorWindowMs = clampInt(inject.fatalErrorWindowMs, 60000, 1, Infinity);
  const fatalSendErrorCount = clampInt(inject.fatalErrorCount, 2, 2, Infinity);
  const tickMs = clampInt(inject.tickMs, 1000, 1, Infinity);
  const now = () => Date.now();
  const setTimer = typeof inject.setInterval === 'function' ? inject.setInterval : setInterval;
  const clearTimer = typeof inject.clearInterval === 'function' ? inject.clearInterval : (h) => { clearInterval(h); return h; };

  let state = 'ok';
  let feedWindow = 0;
  let zeroTicks = 0;
  let lastBytes = null;
  let fatalError = false;
  let closed = false;
  const recycleStamps = [];
  const sendErrorStamps = [];
  let timer = null;

  const prune = (list, windowMs) => {
    const min = now() - windowMs;
    let i = 0;
    while (i < list.length && list[i] < min) i += 1;
    if (i) list.splice(0, i);
    return list.length;
  };
  const inWindow = (list, windowMs) => list.filter((t) => t >= now() - windowMs).length;

  function escalate() {
    if (fatalError) return;
    fatalError = true;
    state = 'fatal';
    try { onFatal(); } catch { /* the caller owns process exit */ }
  }

  // Record a recycle and fire onStall exactly once per stale episode. If the
  // rolling window of recycles inside recycleWindowSec exceeds recycleMax,
  // escalate to fatal immediately (onStall is suppressed — the operator
  // already asked for the worker to restart).
  function recordRecycleAndNotify() {
    recycleStamps.push(now());
    prune(recycleStamps, recycleWindowMs);
    if (recycleStamps.length > recycleMax) { escalate(); return; }
    if (fatalError) return;
    state = 'stalled';
    feedWindow = 0;
    try { onStall(); } catch { /* the recycle handler owns escalation */ }
  }

  function sample() {
    if (closed || fatalError) return;
    let pc = null;
    try { pc = getPC(); } catch { pc = null; }
    if (!pc || typeof pc !== 'object' || typeof pc.bytesSent !== 'function') {
      feedWindow = 0; zeroTicks = 0; lastBytes = null;
      if (state === 'stalled') state = 'ok';
      return;
    }
    let bytes;
    let readOK = false;
    try {
      bytes = pc.bytesSent();
      if (typeof bytes === 'number') readOK = true;
    } catch { readOK = false; }
    const healthy = feedWindow === 0 || (readOK && lastBytes !== null && bytes > lastBytes);
    if (healthy) {
      zeroTicks = 0;
      if (state === 'stalled') state = 'ok';
      if (readOK) lastBytes = bytes;
      feedWindow = 0;
      return;
    }
    if (feedWindow > 0) {
      zeroTicks += 1;
      if (readOK) lastBytes = bytes;
      if (state === 'ok' && zeroTicks >= stallSec) recordRecycleAndNotify();
    }
  }

  // The native send path threw at our boundary. A throw is unambiguous
  // evidence of a stalled/broken PC, so treat it as a hard stall signal:
  // fire onStall, then track send errors — a second one within
  // fatalErrorWindowMs escalates to fatal.
  function noteSendError() {
    if (closed || fatalError) return;
    sendErrorStamps.push(now());
    prune(sendErrorStamps, fatalErrorWindowMs);
    if (state === 'ok') recordRecycleAndNotify();
    if (state === 'stalled' && inWindow(sendErrorStamps, fatalErrorWindowMs) >= fatalSendErrorCount) escalate();
  }

  // The recycle owner (streamManager._recycleOnStall) calls this the moment
  // a link is torn down and a fresh PC is about to be attached. A fresh
  // PeerConnection's bytesSent() restarts LOW, and in the never-drains mode
  // it stays flat — so the pre-recycle lastBytes (stale) would make
  // "bytes > lastBytes" false on every post-recycle tick, and the latched
  // state='stalled' would survive. Together those make the `state === 'ok'`
  // gate in sample() permanently block onStall #2 AND the
  // recycleStamps > recycleMax fatal escalation (the verified failure where
  // recycles froze at 1 and RSS ran to the cap). Re-arm the baselines +
  // latch here. recycleStamps are intentionally PRESERVED: escalation is
  // keyed on how many recycles have happened within the window, independent
  // of re-arming, so it survives a rejoin into a fresh link.
  function resetBaseline() {
    if (fatalError) return;
    lastBytes = null;
    zeroTicks = 0;
    feedWindow = 0;
    if (state === 'stalled') state = 'ok';
  }

  function tickFeed() {
    if (closed) return;
    feedWindow += 1;
  }

  timer = setTimer(() => sample(), tickMs);
  if (timer && typeof timer.unref === 'function') { try { timer.unref(); } catch { /* not a real handle */ } }

  function close() {
    if (closed) return;
    closed = true;
    if (timer) { try { clearTimer(timer); } catch { /* already cleared */ } }
    timer = null;
  }

  return {
    get state() { return state; },
    get recycles() { return inWindow(recycleStamps, recycleWindowMs); },
    tickFeed,
    noteSendError,
    sample,
    resetBaseline,
    close
  };
}

module.exports = { createSendSupervisor };
