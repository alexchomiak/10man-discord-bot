'use strict';
// Scenario A: unbounded NATIVE send/retransmit queue under backpressure.
//
// Real stack, no fakes:
//   - loopback PeerConnection A <-> B (libdatachannel, via @lng2004/node-datachannel)
//   - A's video Track wired EXACTLY like WebRtcWrapper.setPacketizer:
//     H264RtpPacketizer + RtcpSrReporter + RtcpNackResponder + PacingHandler(25Mbps,1ms)
//   - B is alive and drains the RTCP/metadata channels, but A's RTP send pipeline is
//     intentionally faster than PacingHandler will emit (25Mbps < 30fps * 60..200KiB
//     of synthesized frames)  ... actually we run at the configured FPS, so backpressure
//     is induced by the receiver not ACKing RTP (we don't install onMessage on B's
//     track, and we do not respond to RTCP NACK/RTP feedback that would drain A's
//     internal retransmit buffer).
//
// The pump loop discards the return value of sendMessageBinary EXACTLY like
// WebRtcWrapper.js:121 does. The native memory growth is what we are measuring.
//
// Env knobs:
//   SBOT_DURATION_MS    (default 60000)
//   SBOT_FRAME_BYTES    (default 204800 = 200KiB; capped to track.maxMessageSize())
//   SBOT_FPS            (default 30)
const path = require('path');
const common = require('./common');
const { connectLoopback, synthesizeFrame, makeSampler } = common;

async function main() {
  const DURATION_MS = parseInt(process.env.SBOT_DURATION_MS || '60000', 10);
  const FRAME_BYTES = parseInt(process.env.SBOT_FRAME_BYTES || '204800', 10);
  const FPS = Math.max(1, parseInt(process.env.SBOT_FPS || '30', 10));
  const TSV = process.env.SBOT_TSV || path.join(__dirname, 'out', 'scenario_a.tsv');

  const { A, videoTrack } = await connectLoopback({ killAfterConnect: false });
  const max = videoTrack.maxMessageSize();
  const frame = synthesizeFrame(FRAME_BYTES);
  process.stdout.write('A: connected. maxMessageSize=' + max + ' frame=' + frame.length + ' bytes. fps=' + FPS + ' duration=' + DURATION_MS + 'ms\n');

  const sampler = makeSampler(TSV);
  const t0 = Date.now();
  let framesSent = 0, okCount = 0, failCount = 0;
  const frameInterval = 1000 / FPS;

  const timer = setInterval(() => {
    sampler.snap(((Date.now() - t0) / 1000).toFixed(2), framesSent, 1);
  }, 2000);
  sampler.snap('0.00', 0, 1);

  // Pump at FPS, discarding return values.
  let lastTick = Date.now();
  while (Date.now() - t0 < DURATION_MS) {
    const ok = videoTrack.sendMessageBinary(frame); // return value intentionally discarded
    framesSent++; if (ok) okCount++; else failCount++;
    const wait = lastTick + frameInterval - Date.now();
    if (wait > 1) await new Promise((r) => setTimeout(r, wait));
    lastTick = Date.now();
    if (framesSent % 400 === 0 && global.gc) global.gc();
  }

  sampler.snap(((Date.now() - t0) / 1000).toFixed(2), framesSent, 1);
  clearInterval(timer);
  sampler.close();
  A.close();
  process.stdout.write('A: DONE frames=' + framesSent + ' ok=' + okCount + ' fail=' + failCount + '\n');
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write('A: FATAL ' + (e && (e.stack || e.message) || e) + '\n');
  process.exit(1);
});
