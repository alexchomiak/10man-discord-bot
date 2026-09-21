'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createSendSupervisor } = require('../src/streambot/sendSupervisor');

// The supervisor's internal clock/timer are injectable so tests run
// deterministically without real intervals (which would leak past the test).
// We inject a no-op interval and drive sampling by calling sup.sample()
// directly at the exact "tick" boundaries we want to observe.
function makeSupervisor(opts = {}) {
  const sup = createSendSupervisor({ ...opts, config: { ...(opts.config || {}), setInterval: () => 0 } });
  return sup;
}

function fakePC({ bytes = 0, throwRead = false, missing = false, throwGet = false } = {}) {
  if (missing) return null;
  return {
    state: () => 'connected',
    bytesSent: () => { if (throwRead) throw new Error('Track is closed'); return bytes; }
  };
}

test('healthy deltas keep state ok and never fire onStall', (t) => {
  const stall = []; const fatal = [];
  let sent = 0;
  const pc = fakePC({});
  const sup = makeSupervisor({
    getPC: () => { sent += 1024; return { bytesSent: () => sent, state: () => 'connected' }; },
    onStall: () => stall.push(1), onFatal: () => fatal.push(1),
    config: { stallSec: 5 }
  });
  t.after(() => sup.close());
  assert.equal(sup.state, 'ok');
  sup.tickFeed(); sup.sample();
  sup.tickFeed(); sup.sample();
  sup.tickFeed(); sup.sample();
  assert.equal(sup.state, 'ok');
  assert.equal(stall.length, 0);
  assert.equal(fatal.length, 0);
});

test('feeding with 0-delta for stallSec ticks fires onStall exactly once, then recovers', (t) => {
  const stall = []; const fatal = [];
  let sent = 1000;
  const getPC = () => ({ bytesSent: () => sent, state: () => 'connected' });
  const sup = makeSupervisor({
    getPC, onStall: () => stall.push(1), onFatal: () => fatal.push(1),
    config: { stallSec: 3 }
  });
  t.after(() => sup.close());
  // First read establishes the baseline (lastBytes = 1000).
  sup.tickFeed(); sup.sample();
  assert.equal(sup.state, 'ok', 'a single zero-delta read must not be a stall');
  sup.tickFeed(); sup.sample();
  assert.equal(sup.state, 'ok');
  sup.tickFeed(); sup.sample();
  assert.equal(sup.state, 'stalled', 'stallSec consecutive zero-delta ticks must fire once');
  assert.equal(stall.length, 1);
  // Keep feeding with no progress: still latched, no extra onStall.
  sup.tickFeed(); sup.sample();
  assert.equal(stall.length, 1, 'onStall must fire exactly once per episode');
  assert.equal(fatal.length, 0);
  // Recovery: a nonzero delta returns to ok and clears the latch.
  sent += 512;
  sup.tickFeed(); sup.sample();
  assert.equal(sup.state, 'ok');
  sup.tickFeed(); sup.sample();
  assert.equal(sup.state, 'ok');
  assert.equal(stall.length, 1);
});

test('no tickFeed calls within a window means no stall (feed-absent)', (t) => {
  const stall = []; const fatal = [];
  let ticks = 0;
  const sup = makeSupervisor({
    getPC: () => ({ bytesSent: () => 0, state: () => 'connected' }),
    onStall: () => stall.push(1), onFatal: () => fatal.push(1),
    config: { stallSec: 5 }
  });
  t.after(() => sup.close());
  for (let i = 0; i < 10; i++) { ticks = i + 1; sup.sample(); }
  assert.equal(sup.state, 'ok', 'the supervisor is not feeding, so there is no stall by definition');
  assert.equal(ticks, 10);
  assert.equal(stall.length, 0);
  assert.equal(fatal.length, 0);
});

test('noteSendError is a hard stall signal (fires onStall immediately)', (t) => {
  const stall = []; const fatal = [];
  const sup = makeSupervisor({
    getPC: () => ({ bytesSent: () => 0, state: () => 'connected' }),
    onStall: () => stall.push(1), onFatal: () => fatal.push(1),
    config: { stallSec: 5 }
  });
  t.after(() => sup.close());
  sup.noteSendError();
  assert.equal(sup.state, 'stalled', 'a send-path throw at our boundary must immediately stall');
  assert.equal(stall.length, 1, 'onStall must fire exactly once even though there is no stall-tick history');
  assert.equal(fatal.length, 0, 'a single send error must not escalate to fatal');
});

test('two send errors within the window while stalled fire onFatal', (t) => {
  const stall = []; const fatal = [];
  const sup = makeSupervisor({
    getPC: () => ({ bytesSent: () => 0, state: () => 'connected' }),
    onStall: () => stall.push(1), onFatal: () => fatal.push(1),
    config: { stallSec: 5, fatalErrorWindowMs: 60000 }
  });
  t.after(() => sup.close());
  sup.noteSendError();
  assert.equal(fatal.length, 0);
  sup.noteSendError();
  assert.equal(fatal.length, 1, 'a second in-window send error must escalate');
  assert.equal(stall.length, 1, 'onStall only fires once (the first error)');
  assert.equal(sup.state, 'fatal');
  // A third error must not re-fire fatal (latch).
  sup.noteSendError();
  assert.equal(fatal.length, 1);
});

test('recycleMax recycles in the window escalate to onFatal', (t) => {
  const stall = []; const fatal = [];
  let bytes = 0;
  // Each recycle episode: the PC stalls (bytesSent stuck), the operator
  // (onStall → _recycleOnStall) tears down and re-links. We model that as a
  // bump to bytesSent after each onStall so the supervisor sees a healthy
  // moment and clears the latch. Then the next stale episode fires onStall
  // again. The 4th episode exceeds recycleMax (3) and escalates.
  const pc = {
    bytesSent: () => bytes,
    state: () => 'connected'
  };
  const sup = makeSupervisor({
    getPC: () => pc,
    onStall: () => { stall.push(1); bytes += 1024; },
    onFatal: () => fatal.push(1),
    config: { stallSec: 1, recycleMax: 3, recycleWindowSec: 600 }
  });
  t.after(() => sup.close());
  // Drive 3 full episodes (each = onStall fires + one healthy sample) then
  // a 4th attempt that must escalate (not call onStall).
  for (let i = 0; i < 3; i++) {
    sup.tickFeed(); sup.sample();
    assert.equal(stall.length, i + 1);
    assert.equal(fatal.length, 0);
    assert.equal(sup.state, 'stalled');
    sup.sample(); // healthy (bumped bytesSent), state clears to ok
    assert.equal(sup.state, 'ok');
  }
  // 4th episode — the recycle window has 3 prior recycles, so this one
  // should trigger onFatal WITHOUT calling onStall a 4th time.
  sup.tickFeed(); sup.sample();
  assert.equal(stall.length, 3, 'onStall must be suppressed at the escalation boundary');
  assert.equal(fatal.length, 1, 'a recycle past the windowed maximum must escalate');
  assert.equal(sup.state, 'fatal');
});

test('getPC returning null is a no-op that recovers state', (t) => {
  const stall = []; const fatal = [];
  let pc = fakePC({});
  const sup = makeSupervisor({
    getPC: () => pc, onStall: () => stall.push(1), onFatal: () => fatal.push(1),
    config: { stallSec: 5 }
  });
  t.after(() => sup.close());
  assert.equal(sup.state, 'ok');
  // No stall when not feeding and PC present.
  sup.sample();
  assert.equal(stall.length, 0);
  // Now getPC returns null: supervisor must reset counters, no action.
  pc = null;
  for (let i = 0; i < 6; i++) sup.sample();
  assert.equal(sup.state, 'ok');
  assert.equal(stall.length, 0);
  assert.equal(fatal.length, 0);
});

test('bytesSent throwing is a read-error: stall path, does not propagate', (t) => {
  const stall = []; const fatal = [];
  let shouldThrow = false;
  const sup = makeSupervisor({
    getPC: () => ({
      state: () => 'connected',
      bytesSent: () => { if (shouldThrow) throw new Error('Native read failure'); return 42; }
    }),
    onStall: () => stall.push(1), onFatal: () => fatal.push(1),
    config: { stallSec: 2 }
  });
  t.after(() => sup.close());
  // Baseline read succeeds (42).
  sup.tickFeed(); sup.sample();
  assert.equal(sup.state, 'ok');
  // Turn on read failures; two more feeding ticks should fire onStall.
  shouldThrow = true;
  sup.tickFeed(); sup.sample();
  sup.tickFeed(); sup.sample();
  assert.equal(sup.state, 'stalled');
  assert.equal(stall.length, 1);
  assert.ok(!fatal.length, 'a read error alone must not escalate to fatal');
});

// --- Recycle / rejoin regression (Agent 6) ----------------------------------
// The verified production failure: onStall #1 fires, a rejoin happens, and the
// supervisor gets PERMANENTLY latched at 'stalled' so onStall #2 never fires,
// the recycleStamps > recycleMax escalation never triggers, and the leak runs
// away to the RSS cap. resetBaseline() is the fix; these tests pin it.
//
// In the never-drains mode the native PC's bytesSent() is flat (even a fresh
// PC's counter does not advance), so model a flat bytesSent() with a
// rejoin = swapping the PC object (getPC is a closure over a mutable ref).
test('resetBaseline re-arms the latch so a 2nd and 3rd stall re-fire (recycleMax -> onFatal)', (t) => {
  const stall = []; const fatal = [];
  // Flat bytesSent (never drains) on every PC generation.
  const flatPC = () => ({ bytesSent: () => 0, state: () => 'connected' });
  let pc = flatPC();
  const sup = makeSupervisor({
    getPC: () => pc,
    onStall: () => { stall.push(1); pc = flatPC(); }, // operator swaps in a fresh PC (rejoin)
    onFatal: () => fatal.push(1),
    config: { stallSec: 2, recycleMax: 2, recycleWindowSec: 600 }
  });
  t.after(() => sup.close());

  // --- Recycle #1: flat + feed for stallSec ticks => onStall fires.
  sup.tickFeed(); sup.sample();
  assert.equal(sup.state, 'ok', 'a single zero-delta read while not yet stalling must not fire');
  sup.tickFeed(); sup.sample();
  assert.equal(sup.state, 'stalled', 'stallSec flat ticks while feeding must fire onStall #1');
  assert.equal(stall.length, 1);
  // THE BUG: without resetBaseline the stale latch stays and the 2nd episode
  // is swallowed. Rejoin happens here; the recycle owner re-arms baselines.
  sup.resetBaseline();
  assert.equal(sup.state, 'ok', 'resetBaseline must re-arm the latch to ok');

  // --- Recycle #2: second stall window on the FRESH PC must re-fire onStall.
  sup.tickFeed(); sup.sample();
  sup.tickFeed(); sup.sample(); // flat again on the fresh PC
  assert.equal(sup.state, 'stalled', 'onStall must RE-FIRE after a rejoin (the reported failure)');
  assert.equal(stall.length, 2, 'onStall #2 must fire after resetBaseline');
  sup.resetBaseline();

  // --- Recycle #3: exceeds recycleMax(2) in-window => escalate to onFatal, do NOT onStall.
  sup.tickFeed(); sup.sample();
  sup.tickFeed(); sup.sample();
  assert.equal(stall.length, 2, 'onStall must be suppressed at the escalation boundary');
  assert.equal(fatal.length, 1, 'a 3rd recycle within the window must escalate to fatal');
  assert.equal(sup.state, 'fatal');
  assert.equal(sup.recycles, 3, 'the escalation count survives rejoin (resetBaseline preserves it)');
});

test('resetBaseline re-baselines lastBytes so a LOW fresh PC does not read healthy AND does not false-stall', (t) => {
  const stall = []; const fatal = [];
  // gen1 (leaking) PC reports high bytesSent (GB-scale) that STOPS advancing;
  // gen2 (fresh) PC reports LOW bytesSent that is STUCK. The spurious-delta
  // trap: pre-recycle lastBytes is HIGH, post-recycle fresh PC is LOW, so
  // "bytes > lastBytes" is false -> without a resetBaseline the stale
  // lastBytes poisons the delta and the latch never re-arms. With it, the
  // fresh PC gets its own baseline and the next flat episode stalls cleanly.
  let gen = 0;
  let high = 5_000_000_000; // gen1 pre-recycle baseline (GBs)
  const lowPC = { bytesSent: () => 1024, state: () => 'connected' }; // gen2 fresh (low, stuck)
  const sup = makeSupervisor({
    getPC: () => (gen === 0
      ? { bytesSent: () => high, state: () => 'connected' }   // gen1 (high, then flat)
      : lowPC),                                               // gen2 (low, stuck)
    onStall: () => { stall.push(1); gen = 1; high = 0; }, // gen1 stalls -> operator swaps to gen2 (rejoin)
    onFatal: () => fatal.push(1),
    config: { stallSec: 2, recycleMax: 5, recycleWindowSec: 600 }
  });
  t.after(() => sup.close());

  // Establish gen1 baseline and let it stall (high flat).
  sup.tickFeed(); sup.sample(); // lastBytes = 5e9 (gen1 healthy baseline moment)
  assert.equal(sup.state, 'ok');
  sup.tickFeed(); sup.sample(); // zeroTicks=1
  high = 5_000_000_000; // gen1 flat (same value) -> delta 0 -> tick 2
  sup.tickFeed(); sup.sample();
  assert.equal(sup.state, 'stalled', 'gen1 flat-for-stallSec must fire onStall #1');
  assert.equal(stall.length, 1);
  // Rejoin: operator swaps in the fresh (low, stuck) PC and re-arms.
  sup.resetBaseline();
  assert.equal(sup.state, 'ok', 'latch re-armed');

  // The spurious trap would be: stale lastBytes=5e9 makes fresh PC(1024)
  // look "unhealthy" but not "stalled" (lastBytes stays 5e9, delta can't go
  // positive, zeroTicks stays < stallSec forever). WITH resetBaseline,
  // lastBytes is cleared, so the fresh PC re-baselines and a flat episode
  // stalls cleanly instead of hanging.
  sup.tickFeed(); sup.sample(); // fresh PC baseline (1024)
  assert.equal(sup.state, 'ok', 'a single flat read on the fresh PC must not stall');
  sup.tickFeed(); sup.sample(); // flat again -> this must be tick 2 of a REAL stall
  assert.equal(sup.state, 'stalled', 'fresh-PC flat episode must re-fire, not hang on stale lastBytes');
  assert.equal(stall.length, 2, 'onStall #2 must fire (the reported failure was it freezing at 1)');
  assert.equal(fatal.length, 0);
});
