'use strict';
// Local RTP transport experiment; synthetic NALs test packet delivery, not decoding.
// Run with Node >=22: node scripts/repro-native-pacer.cjs [pacer interval ms | 0 | adaptive]
// REPRO_DURATION_MS defaults to 6000; allowed duration is 1000..30000 ms.
const rtc = require('@lng2004/node-datachannel');
const { setTimeout: sleep } = require('node:timers/promises');
const adaptive = process.argv[2] === 'adaptive';
const interval = adaptive ? 2 : Number(process.argv[2] ?? 1);
const durationMs = Number(process.env.REPRO_DURATION_MS || 6000);
async function main() {
  const { pathToFileURL } = require('node:url');
  const path = require('node:path');
  const root = path.dirname(require.resolve('@dank074/discord-video-stream'));
  const { BitrateCalculator } = await import(pathToFileURL(path.join(root, 'client/voice/BitrateCalculator.js')));
  const bitrate = new BitrateCalculator();
  if (!Number.isFinite(interval) || !Number.isInteger(interval) || interval < 0 || interval > 20)
    throw new Error('Pacer interval must be an integer from 0 to 20 ms');
  if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > 30000)
    throw new Error('REPRO_DURATION_MS must be a finite number from 1000 to 30000 ms');
  const sender = new rtc.PeerConnection('sender', { iceServers: [] });
  const receiver = new rtc.PeerConnection('receiver', { iceServers: [] });
  const expected = new Map(); const received = new Map();
  let falseReturns = 0; let packets = 0; let firstAt; let lastAt; let maxGapMs = 0;
  let receiverTrack; let lastPacketAt; let packetGapMaxMs = 0;
  const arrivals = [];
  receiver.onTrack(track => {
    receiverTrack = track;
    track.onMessage(packet => {
      if (!Buffer.isBuffer(packet) || packet.length < 12 || packet[1] >= 192 && packet[1] <= 223) return;
      packets++;
      const arrival = performance.now();
      if (lastPacketAt !== undefined) packetGapMaxMs = Math.max(packetGapMaxMs, arrival - lastPacketAt);
      lastPacketAt = arrival; arrivals.push({ at: arrival, bytes: packet.length });
      const timestamp = packet.readUInt32BE(4); const seq = packet.readUInt16BE(2);
      let record = received.get(timestamp);
      if (!record) received.set(timestamp, record = { sequences: new Set(), marker: false, bytes: 0 });
      if (!record.sequences.has(seq)) {
        let offset = 12 + (packet[0] & 15) * 4;
        if (packet[0] & 16) offset += 4 + packet.readUInt16BE(offset + 2) * 4;
        const payload = packet.subarray(offset);
        record.bytes += payload.length - ((payload[0] & 31) === 28 ? 2 : 1);
      }
      record.sequences.add(seq);
      if (packet[1] & 128) {
        record.marker = true; record.at = performance.now();
        firstAt ??= record.at;
        if (lastAt !== undefined) maxGapMs = Math.max(maxGapMs, record.at - lastAt);
        lastAt = record.at;
      }
    });
  });
  sender.onLocalDescription((sdp, type) => receiver.setRemoteDescription(sdp, type));
  receiver.onLocalDescription((sdp, type) => sender.setRemoteDescription(sdp, type));
  sender.onLocalCandidate((candidate, mid) => receiver.addRemoteCandidate(candidate, mid));
  receiver.onLocalCandidate((candidate, mid) => sender.addRemoteCandidate(candidate, mid));
  const video = new rtc.Video('video', 'SendOnly'); video.addH264Codec(101); video.addSSRC(42, 'repro');
  const track = sender.addTrack(video);
  const config = new rtc.RtpPacketizationConfig(42, 'repro', 101, 90000);
  config.playoutDelayId = 5; config.playoutDelayMin = 0; config.playoutDelayMax = 10;
  const packetizer = new rtc.H264RtpPacketizer('StartSequence', config);
  packetizer.addToChain(new rtc.RtcpSrReporter(config)); packetizer.addToChain(new rtc.RtcpNackResponder());
  const pacer = interval ? new rtc.PacingHandler(adaptive ? 10_000_000 : 25_000_000, interval) : null;
  if (pacer) packetizer.addToChain(pacer);
  track.setMediaHandler(packetizer);
  sender.setLocalDescription();
  const timeoutAt = performance.now() + 10000;
  while (!(track.isOpen() && receiverTrack?.isOpen())) {
    if (performance.now() > timeoutAt) throw new Error(`Handshake timeout: ${sender.state()}/${receiver.state()}`);
    await sleep(20);
  }
  const started = performance.now(); let index = 0;
  while (performance.now() - started < durationMs) {
    // 5 Mbps average: 150 KB keyframe every two seconds, 18.644 KB interframes.
    const bytes = index % 60 === 0 ? 150000 : 18644;
    const nal = Buffer.alloc(bytes, 0x55); nal.set([0, 0, 0, 1, index % 60 ? 0x41 : 0x65]);
    const timestamp = config.timestamp;
    const sentAt = performance.now();
    if (adaptive) pacer.setBitrate(Math.max(1000000, bitrate.addSample(nal.length) * 1.25));
    if (track.sendMessageBinary(nal) === false) falseReturns++;
    expected.set(timestamp, { bytes: bytes - 5, sentAt });
    config.timestamp = (timestamp + 3000) >>> 0;
    index++;
    await sleep(Math.max(0, started + index * 1000 / 30 - performance.now()));
  }
  const stoppedAt = performance.now();
  const completeAtStop = [...expected].filter(([ts, e]) => received.get(ts)?.bytes === e.bytes && received.get(ts)?.marker).length;
  await sleep(1500);
  const latencies = [...expected].flatMap(([ts, e]) => received.get(ts)?.bytes === e.bytes && received.get(ts)?.marker ? [received.get(ts).at - e.sentAt] : []).sort((a,b) => a-b);
  const completed = latencies.length;
  const windowMax = ms => {
    let left = 0; let bytes = 0; let maximum = 0;
    for (let right = 0; right < arrivals.length; right++) {
      bytes += arrivals[right].bytes;
      while (arrivals[right].at - arrivals[left].at >= ms) bytes -= arrivals[left++].bytes;
      maximum = Math.max(maximum, bytes);
    }
    return maximum;
  };
  console.log(JSON.stringify({ mode: adaptive ? "adaptive" : "fixed", intervalMs: interval, durationMs, framesSent: index, packets, falseReturns,
    completedAtStop: completeAtStop, completedAfterDrain: completed, missingFrames: index - completed,
    packetGapMaxMs, maxRtpBytes1Ms: windowMax(1), maxRtpBytes5Ms: windowMax(5),
    markerMaxGapMs: Math.round(maxGapMs * 100) / 100,
    latencyP50Ms: latencies[Math.floor(latencies.length * .5)], latencyP95Ms: latencies[Math.floor(latencies.length * .95)],
    latencyMaxMs: latencies.at(-1), tailAfterStopMs: Math.max(0, (lastAt || stoppedAt) - stoppedAt) }));
  sender.close(); receiver.close(); rtc.cleanup();
}
main().catch(error => { console.error(error); process.exitCode = 1; rtc.cleanup(); });
