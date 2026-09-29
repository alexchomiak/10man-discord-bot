'use strict';

// Adapter for the pinned discord-video-stream 6.0.0 WebRtcConnWrapper.
// Replace its video packetizer before the first frame, retaining the RTP
// configuration, codec, packet size, NACK responder and sender reports.
function configureVideoTransport(connection, { codec, bitrateKbps = 5000, vbvBufferKbits, diagnostics = false } = {}) {
  const track = connection._videoTrack;
  const config = connection._videoPacketizer?.rtpConfig;
  if (!track || !config) return null;
  const rtc = require('@lng2004/node-datachannel');
  const rate = Number.isFinite(bitrateKbps) && bitrateKbps > 0 ? bitrateKbps : 5000;
  const vbv = Number.isFinite(vbvBufferKbits) && vbvBufferKbits > 0
    ? vbvBufferKbits : Math.max(500, Math.round(rate * 0.3));
  // Keep twice the encoder's peak and enough rate to drain a VBV-sized
  // keyframe in 75ms, inside the existing 100ms receiver playout allowance.
  // A 4 Mbps / 1200 kbit VBV stream uses 16 Mbps instead of a fixed 25 Mbps.
  const pacingBps = Math.ceil(Math.max(rate * 1.4 * 2, vbv / 0.075) * 1000);
  // This RTP extension is in 10ms units. Allow adaptive receiver smoothing
  // up to 300ms rather than constraining it to the library's 100ms maximum.
  // Keep the zero minimum, so this is allowance rather than a forced delay.
  config.playoutDelayMax = 30;
  const packetizer = codec === 'H264' ? new rtc.H264RtpPacketizer('StartSequence', config)
    : codec === 'H265' ? new rtc.H265RtpPacketizer('StartSequence', config)
      : codec === 'AV1' ? new rtc.AV1RtpPacketizer('Obu', config) : null;
  if (!packetizer) throw new Error(`Unsupported RTP codec: ${codec}`);
  packetizer.addToChain(new rtc.RtcpSrReporter(config));
  packetizer.addToChain(new rtc.RtcpNackResponder());
  packetizer.addToChain(new rtc.PacingHandler(pacingBps, 1));
  track.setMediaHandler(packetizer);
  connection._videoPacketizer = packetizer;

  const reports = diagnostics ? createReceiverReports(connection.mediaConnection.webRtcParams.videoSsrc) : null;
  if (reports) track.onMessage(reports.consume);
  return { pacingBps, takeDiagnostics: () => ({ pacingKbps: pacingBps / 1000,
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
