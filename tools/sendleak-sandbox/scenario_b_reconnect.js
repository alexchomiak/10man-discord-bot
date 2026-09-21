'use strict';
// Scenario B: orphaned PeerConnection on reconnect (the F-3 hypothesis).
//
// Faithful model of "reconnect while Discord (the remote) stays alive":
//   - each iteration builds a REAL connected loopback pair A<->B (B stands in
//     for the Discord voice endpoint; it stays alive),
//   - we burst-send frames through A's video Track (open + connected, so the
//     C++ send/retransmit + pacing buffers get allocated),
//   - then we OVERWRITE our references to A AND its Tracks with a fresh pair,
//     WITHOUT calling .close()/.cleanup() on the old ones
//     (mirrors WebRtcWrapper.initWebRtc at WebRtcWrapper.js:42-50 and the
//     reconnect path at BaseMediaConnection.js:476-494),
//   - and we deliberately keep B (the "remote/Discord") alive, exactly as the
//     real remote would stay up while our side abandons the connection.
//
// Controlled comparison: set SBOT_CALL_CLOSE=true to close each old A+Tracks
// before creating the next one. If the growth in ORPHAN mode collapses in
// CLOSE mode, hypothesis #2 (orphaned reconnect) is confirmed.
//
// Env:
//   SBOT_CONN_ITERS    (default 20)
//   SBOT_BURST_FRAMES  (default 500)
//   SBOT_CALL_CLOSE    (default off)
const path = require('path');
const common = require('./common');
const { connectLoopback, synthesizeFrame, makeSampler } = common;

async function main() {
  const ITERS = parseInt(process.env.SBOT_CONN_ITERS || '20', 10);
  const BURST = parseInt(process.env.SBOT_BURST_FRAMES || '500', 10);
  const CALL_CLOSE = process.env.SBOT_CALL_CLOSE === 'true';
  const TSV = process.env.SBOT_TSV || path.join(__dirname, 'out', 'scenario_b.tsv');

  process.stdout.write('B: iters=' + ITERS + ' burst=' + BURST + ' callClose=' + CALL_CLOSE + '\n');
  const sampler = makeSampler(TSV);
  const t0 = Date.now();
  let totalFrames = 0;
  const orphans = []; // A-side connections we have abandoned

  for (let i = 0; i < ITERS; i++) {
    // Fresh, REAL connected pair. B stays alive (it is the "remote/Discord").
    const pair = await connectLoopback({ killAfterConnect: false });
    const frame = synthesizeFrame(Math.min(4096, pair.videoTrack.maxMessageSize()));

    // Burst through the real, connected pipeline (return values discarded,
    // exactly like WebRtcWrapper.js:121). Best-effort: the loopback reaches
    // state()=='connected' but the A-side media transport is not always in a
    // fully sendable state, so a valid-size send can throw "Track is not open".
    // That is fine - the point of scenario B is the per-iteration NATIVE cost of
    // creating + abandoning a PeerConnection, not successful delivery.
    let sentOk = 0;
    for (let j = 0; j < BURST; j++) {
      try {
        if (pair.videoTrack.sendMessageBinary(frame)) sentOk++;
      } catch (e) {
        // "Track is not open" / rejected: count the attempt, keep iterating.
      }
    }
    totalFrames += BURST;
    if (i === 0) process.stdout.write('B: iter0 burst sentOk=' + sentOk + '/' + BURST + '\n');

    if (CALL_CLOSE) {
      // Control arm: clean teardown of every A/B pair we've created so far.
      for (const o of orphans) {
        try { o.tracks.forEach((t) => t.close()); } catch (e) {}
        try { o.A.close(); } catch (e) {}
        try { o.B.close(); } catch (e) {}
      }
      orphans.length = 0;
    } else {
      // ORPHAN arm (F-3): drop our references to A + its tracks. Keep B alive.
      orphans.push({ A: pair.A, tracks: [pair.audioTrack, pair.videoTrack], B: pair.B });
    }

    // Give the JS GC a real chance to run between iterations
    // (do NOT call global.gc() here - we want to see what the GC does on its own).
    await new Promise((r) => setTimeout(r, 200));

    sampler.snap(((Date.now() - t0) / 1000).toFixed(2), totalFrames, CALL_CLOSE ? 1 : i + 1);
  }

  // End-of-run: force GC and re-sample so we can read "reachable-but-GC-deferred"
  // apart from a true native leak. If the drop after global.gc() is ~0, the growth
  // is NOT V8 reclaimable => it is in native libdatachannel buffers/connections.
  const before = { ...process.memoryUsage() };
  if (global.gc) global.gc();
  await new Promise((r) => setTimeout(r, 300));
  if (global.gc) global.gc();
  const after = process.memoryUsage();
  process.stdout.write(
    'B: preGC rss=' + (before.rss / 1048576).toFixed(1) + 'MB ' +
    'postGC rss=' + (after.rss / 1048576).toFixed(1) + 'MB ' +
    'gcReclaimedMB=' + ((before.rss - after.rss) / 1048576).toFixed(1) + '\n'
  );

  // Close everything (both arms) before we exit so we don't leave native handles.
  for (const o of orphans) {
    try { o.tracks.forEach((t) => t.close()); } catch (e) {}
    try { o.A.close(); } catch (e) {}
    try { o.B.close(); } catch (e) {}
  }

  sampler.snap(((Date.now() - t0) / 1000).toFixed(2), totalFrames, CALL_CLOSE ? 0 : ITERS);
  sampler.close();
  process.stdout.write('B: DONE totalFrames=' + totalFrames + ' orphaned=' + (CALL_CLOSE ? 0 : ITERS) + '\n');
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write('B: FATAL ' + (e && (e.stack || e.message) || e) + '\n');
  process.exit(1);
});
