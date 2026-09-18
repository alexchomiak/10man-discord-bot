'use strict';

// demuxGuard: bot-side compatibility shim for node-av Demuxer lifecycle leaks.
//
// Why this exists (confirmed diagnosis, do not re-litigate):
//   node-av's Demuxer.packets() (node_modules/node-av/dist/api/demuxer.js)
//   starts a perpetual demux-thread loop that only exits on isClosed /
//   demuxThreadActive=false. @dank074/discord-video-stream's LibavDemuxer
//   holds the Demuxer instance in a closure (dist/media/LibavDemuxer.js
//   `demux()`), so it is UNREACHABLE from our code — its cleanup() (which
//   calls demuxer.close()) only runs on stream done/error, NOT on
//   abort/stop/watchdog-teardown. Any abnormal session end therefore leaks
//   the demux thread, which then spins the node event loop at ~100% of one
//   core forever and starves the next stream's send loop.
//
// What this does (Option B, monkey-patch from OUR code — no node_modules
// edits):
//   * node-av is a single hoisted copy inside node_modules/, so the ESM
//     namespace our code obtains via import('node-av') is the SAME object the
//     library gets. Patching the shared Demuxer class here is safe and
//     applies once per process.
//   * We wrap the static `Demuxer.open` / `Demuxer.openSync` to record every
//     instance in a module-level Set (`trackedDemuxers`), and wrap
//     `close()` / `closeSync()` to remove the instance when it is closed
//     legitimately (e.g. the library's own cleanup on a clean end).
//   * `closeAllDemuxers()` force-closes every still-open instance
//     (best-effort, per-instance try/catch) and clears the set. Teardown
//     calls it after the existing stop/kill/destroy steps to kill any
//     leaked demux thread.
//
// Patch is idempotent (guarded by `Demuxer.__streambotDemuxerTracker`), so
// repeated calls / re-requires can never double-wrap.

const trackedDemuxers = new Set();
const persistentInputs = new WeakSet();

// NUT already describes our normalized streams. Probing with nobuffer would
// consume and discard the opening frames before the gateway handshake.
function registerPersistentInput(input) { persistentInputs.add(input); }

function installDemuxerTracker(DemuxerCls) {
  if (!DemuxerCls || DemuxerCls.__streambotDemuxerTracker) return;

  // --- static constructors: record instances ---------------------------------
  if (typeof DemuxerCls.open === 'function' && !DemuxerCls.open.__tracked) {
    const origOpen = DemuxerCls.open;
    const wrappedOpen = async function open(input, options) {
      const actual = persistentInputs.has(input)
        ? { ...options, skipStreamInfo: true, options: { ...options?.options, fflags: '0' } }
        : options;
      const instance = await origOpen.call(this, input, actual);
      if (instance && persistentInputs.has(input) && input.destroyed) {
        await instance.close();
        throw new Error('Persistent input closed during demux initialization');
      }
      if (instance) trackedDemuxers.add(instance);
      return instance;
    };
    wrappedOpen.__tracked = true;
    DemuxerCls.open = wrappedOpen;
  }
  if (typeof DemuxerCls.openSync === 'function' && !DemuxerCls.openSync.__tracked) {
    const origOpenSync = DemuxerCls.openSync;
    const wrappedOpenSync = function openSync(input, options) {
      const instance = origOpenSync.call(this, input, options);
      if (instance) trackedDemuxers.add(instance);
      return instance;
    };
    wrappedOpenSync.__tracked = true;
    DemuxerCls.openSync = wrappedOpenSync;
  }

  // --- instance close: untrack on legitimate close ----------------------------
  if (typeof DemuxerCls.prototype.close === 'function' && !DemuxerCls.prototype.close.__tracked) {
    const origClose = DemuxerCls.prototype.close;
    const wrappedClose = async function close() {
      try {
        return await origClose.call(this);
      } finally {
        trackedDemuxers.delete(this);
      }
    };
    wrappedClose.__tracked = true;
    DemuxerCls.prototype.close = wrappedClose;
  }
  if (typeof DemuxerCls.prototype.closeSync === 'function' && !DemuxerCls.prototype.closeSync.__tracked) {
    const origCloseSync = DemuxerCls.prototype.closeSync;
    const wrappedCloseSync = function closeSync() {
      try {
        return origCloseSync.call(this);
      } finally {
        trackedDemuxers.delete(this);
      }
    };
    wrappedCloseSync.__tracked = true;
    DemuxerCls.prototype.closeSync = wrappedCloseSync;
  }

  DemuxerCls.__streambotDemuxerTracker = true;
}

let installPromise = null;

// Import node-av (the SAME hoisted instance the streaming library uses) and
// install the tracker. Safe to call repeatedly; resolves to true when the
// shared Demuxer class is patched.
function ensureTrackerInstalled() {
  if (!installPromise) {
    installPromise = (async () => {
      const nodeAv = await import('node-av');
      installDemuxerTracker(nodeAv.Demuxer);
      return true;
    })();
  }
  return installPromise;
}

// Close a SPECIFIC instance if it is still tracked. Used by the per-piece
// scoped close below and by closeAllDemuxers. Semantics preserved from the
// original: a close() that THROWS rejects this promise (so the allSettled
// callers count it as a failed close), an untracked instance resolves to
// false (a no-op, not counted), and a successful close resolves to true.
async function closeTracked(demuxer) {
  if (!trackedDemuxers.has(demuxer)) return false;
  if (typeof demuxer.close === 'function') await demuxer.close();
  else if (typeof demuxer.closeSync === 'function') demuxer.closeSync();
  return true;
}

// Scope a per-piece teardown to the demuxers THIS append opened.
//
// `baseline` is a snapshot array of the tracker set taken IMMEDIATELY before
// `feeder.append()` ran. We close only demuxers present in the current set
// but NOT in that snapshot (i.e. ones opened during this append) and leave
// anything that pre-existed untouched. Pre-existing instances are typically
// another live piece's demuxer, a shared muxer, or an orphaned-but-still
// pipeline-owned instance that the operator expected to survive past a single
// piece (the existing "orphan survives replacement" test invariant).
//
// The pump loop awaits one piece's iteration (including its finally) before
// shifting the next, so no other code can be registering demuxers
// concurrently with our close — the snapshot is stable for the call.
//
// Resolves to the number of newly-opened demuxers that were actually closed.
async function closeOpenedDemuxers(baseline) {
  const base = Array.isArray(baseline) ? new Set(baseline)
    : (baseline instanceof Set ? baseline : new Set());
  const opened = [...trackedDemuxers].filter((d) => !base.has(d));
  if (opened.length === 0) return 0;
  const results = await Promise.allSettled(opened.map(async (d) => closeTracked(d)));
  for (const demuxer of opened) trackedDemuxers.delete(demuxer);
  return results.filter((r) => r.status === 'fulfilled').length;
}

// Force-close every tracked Demuxer that is still open, then clear the set.
// Best-effort: a throwing close() on one instance never prevents the others
// from being closed. Resolves to the number of instances that were closed
// successfully (0 when nothing was tracked).
async function closeAllDemuxers() {
  const all = [...trackedDemuxers];
  if (all.length === 0) return 0;
  const results = await Promise.allSettled(
    all.map(async (d) => closeTracked(d))
  );
  // Delete only the snapshot we attempted. A timed-out cleanup may finish
  // after a replacement stream has already registered new demuxers; clearing
  // the whole live set here would lose tracking for that new stream.
  for (const demuxer of all) trackedDemuxers.delete(demuxer);
  return results.filter((r) => r.status === 'fulfilled').length;
}

module.exports = {
  trackedDemuxers,
  registerPersistentInput,
  installDemuxerTracker,
  ensureTrackerInstalled,
  closeOpenedDemuxers,
  closeTracked,
  closeAllDemuxers
};
