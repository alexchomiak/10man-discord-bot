'use strict';

// Observe the pinned discord-video-stream 6.0.0 video transport without
// replacing its packetizer, pacing handler, or receiver playout settings.
// Upstream added that transport specifically to address video-only freezes.
function configureVideoTransport(connection, { diagnostics = false } = {}) {
  const track = connection._videoTrack;
  const config = connection._videoPacketizer?.rtpConfig;
  if (!track || !config) return null;
  const reports = diagnostics ? createReceiverReports(connection.mediaConnection.webRtcParams.videoSsrc) : null;
  if (reports) track.onMessage(reports.consume);
  // The targeted backport records the last rate configured on its adaptive pacer.
  return { get pacingBps() { return connection._videoPacingBps ?? null; },
    takeDiagnostics: () => ({ pacingKbps: connection._videoPacingBps == null ? null : connection._videoPacingBps / 1000,
    playoutMaxMs: config.playoutDelayMax * 10, ...reports?.snapshot() }) };
}

// RTCP feedback describes the Discord relay's reception, not every viewer's
// decoder. Retain only the latest matching report, never packet buffers.
function createReceiverReports(ssrc, now = () => performance.now()) {
  let receivedAt = null;
  let fractionLost = null;
  let lostTotal = null;
  let jitterMs = null;
  let pli = 0;
  function consume(buffer) {
    if (!Buffer.isBuffer(buffer)) return;
    for (let offset = 0; offset + 4 <= buffer.length;) {
      if (buffer[offset] >>> 6 !== 2) return;
      const size = (buffer.readUInt16BE(offset + 2) + 1) * 4;
      if (size < 4 || offset + size > buffer.length) return;
      const type = buffer[offset + 1];
      const count = buffer[offset] & 31;
      if (type === 201 || type === 200) {
        const header = type === 201 ? 8 : 28;
        if (header + count * 24 > size) return;
        for (let i = 0; i < count; i++) {
          const block = offset + header + i * 24;
          if (buffer.readUInt32BE(block) !== ssrc) continue;
          fractionLost = buffer[block + 4] * 100 / 256;
          lostTotal = buffer.readIntBE(block + 5, 3);
          jitterMs = buffer.readUInt32BE(block + 12) / 90;
          receivedAt = now();
        }
      } else if (type === 206 && count === 1 && size >= 12 && buffer.readUInt32BE(offset + 8) === ssrc) {
        pli++;
      }
      offset += size;
    }
  }
  function snapshot() {
    const stats = { reportAgeMs: receivedAt === null ? null : Math.max(0, now() - receivedAt),
      lossPct: fractionLost, lostTotal, jitterMs, pli };
    pli = 0;
    return stats;
  }
  return { consume, snapshot };
}

module.exports = { configureVideoTransport, createReceiverReports };
