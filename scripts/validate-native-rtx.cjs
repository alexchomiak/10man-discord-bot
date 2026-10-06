'use strict';
// Transport-only localhost validation. Synthetic NALs do not validate decoding.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { setTimeout: sleep } = require('node:timers/promises');
const rtc = require('@lng2004/node-datachannel');
// Retain every native wrapper until cleanup; native CloseAll traverses wrapper instances.
const nativeOwners = [];
async function until(predicate, label) {
  const end = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() >= end) throw new Error(`Timeout: ${label}`);
    await sleep(10);
  }
}
function payloadOffset(packet) {
  let offset = 12 + (packet[0] & 15) * 4;
  if (packet[0] & 16) offset += 4 + packet.readUInt16BE(offset + 2) * 4;
  return offset;
}
async function validate(codec, Wrapper) {
  const primarySsrc = 42, rtxSsrc = 43;
  const payloadType = codec === 'H264' ? 101 : 103;
  const rtxPayloadType = payloadType + 1;
  const wrapper = new Wrapper({ webRtcParams: { audioSsrc: 41, videoSsrc: primarySsrc, rtxSsrc }, daveReady: false });
  // Reconnect reuses the descriptor; registration must remain idempotent.
  const firstSender = wrapper.initWebRtc();
  nativeOwners.push(firstSender, wrapper._audioTrack, wrapper._videoTrack);
  firstSender.close();
  const sender = wrapper.initWebRtc();
  const receiver = new rtc.PeerConnection(`rtx-${codec}`, { iceServers: [] });
  nativeOwners.push(wrapper, receiver);
  let receiverTrack, offer;
  const originals = [], retransmissions = [];
  const expected = new Map(), received = new Map();
  try {
    receiver.onTrack(track => {
      nativeOwners.push(track);
      if (track.mid() !== '1') return;
      receiverTrack = track;
      track.onMessage(packet => {
        if (!Buffer.isBuffer(packet) || packet.length < 12 || packet[1] >= 192 && packet[1] <= 223) return;
        if (packet.readUInt32BE(8) === primarySsrc) {
          if (originals.length < 32) originals.push(Buffer.from(packet));
          const timestamp = packet.readUInt32BE(4);
          let record = received.get(timestamp);
          if (!record) received.set(timestamp, record = { bytes: 0, marker: false });
          const payload = packet.subarray(payloadOffset(packet));
          const fragmented = codec === 'H264' ? (payload[0] & 31) === 28 : ((payload[0] >> 1) & 63) === 49;
          record.bytes += payload.length - (fragmented ? codec === 'H264' ? 2 : 3 : codec === 'H264' ? 1 : 2);
          if (packet[1] & 128) { record.marker = true; record.at = performance.now(); }
        }
        if (packet.readUInt32BE(8) === rtxSsrc) retransmissions.push(Buffer.from(packet));
      });
    });
    sender.onLocalDescription((sdp, type) => { offer = sdp; receiver.setRemoteDescription(sdp, type); });
    receiver.onLocalDescription((sdp, type) => sender.setRemoteDescription(sdp, type));
    sender.onLocalCandidate((candidate, mid) => receiver.addRemoteCandidate(candidate, mid));
    receiver.onLocalCandidate((candidate, mid) => sender.addRemoteCandidate(candidate, mid));
    // Production creates and negotiates tracks before selecting its packetizer.
    sender.setLocalDescription();
    await until(() => wrapper.ready && receiverTrack?.isOpen(), `${codec} handshake`);
    assert.match(offer, /a=ssrc:42(?:[ \r\n])/, 'initial offer must advertise primary SSRC');
    assert.equal((offer.match(/a=ssrc:42(?:[ \r\n])/g) || []).length, 1, 'reconnect must not duplicate primary SSRC');
    assert.equal((offer.match(/a=ssrc-group:FID 42 43/g) || []).length, 1, 'reconnect must not duplicate FID');
    assert.match(offer, /a=ssrc-group:FID 42 43(?:\r?\n)/, 'initial offer must associate RTX before setPacketizer');
    wrapper.setPacketizer(codec);
    const frame = Buffer.alloc(5000, 0x55);
    frame.set(codec === 'H264' ? [0, 0, 0, 1, 0x65] : [0, 0, 0, 1, 0x26, 1]);
    wrapper.sendVideoFrame(frame, 1000 / 30);
    await until(() => originals.some(packet => packet[1] & 128), `${codec} original frame`);
    const original = originals[0];
    const sequence = original.readUInt16BE(2);
    const nack = Buffer.alloc(16);
    nack[0] = 0x81; nack[1] = 205; nack.writeUInt16BE(3, 2);
    nack.writeUInt32BE(99, 4); nack.writeUInt32BE(primarySsrc, 8); nack.writeUInt16BE(sequence, 12);
    receiverTrack.sendMessageBinary(nack);
    await until(() => retransmissions.length, `${codec} injected NACK retransmission`);
    const retransmission = retransmissions[0];
    assert.equal(retransmission[1] & 127, rtxPayloadType, 'RTX payload type');
    assert.equal(retransmission.readUInt32BE(4), original.readUInt32BE(4), 'RTX timestamp');
    const offset = payloadOffset(retransmission);
    assert.equal(retransmission.readUInt16BE(offset), sequence, 'RTX original sequence number');
    assert.deepEqual(retransmission.subarray(offset + 2), original.subarray(payloadOffset(original)), 'RTX restores original RTP payload');
    const started = performance.now();
    for (let index = 0; index < 180; index++) {
      const bytes = index % 60 === 0 ? 150000 : 18644;
      const nextFrame = Buffer.alloc(bytes, 0x55);
      nextFrame.set(codec === 'H264' ? [0, 0, 0, 1, 0x65] : [0, 0, 0, 1, 0x26, 1]);
      expected.set(wrapper._videoPacketizer.rtpConfig.timestamp, { sentAt: performance.now(), bytes: bytes - (codec === 'H264' ? 5 : 6) });
      wrapper.sendVideoFrame(nextFrame, 1000 / 30);
      await sleep(Math.max(0, started + (index + 1) * 1000 / 30 - performance.now()));
    }
    const stoppedAt = performance.now();
    const complete = () => [...expected].filter(([timestamp, frame]) => received.get(timestamp)?.marker && received.get(timestamp)?.bytes === frame.bytes);
    const completedAtStop = complete().length;
    await until(() => complete().length === expected.size, `${codec} adaptive paced frames drain`);
    const latencies = complete().map(([timestamp, frame]) => received.get(timestamp).at - frame.sentAt).sort((a, b) => a - b);
    const tailMs = Math.max(0, ...complete().map(([timestamp]) => received.get(timestamp).at - stoppedAt));
    assert.equal(complete().length, 180);
    return { codec, adaptiveFramesSent: expected.size, completedAtStop, completedAfterDrain: complete().length,
      latencyP50Ms: latencies[90], latencyP95Ms: latencies[171], latencyMaxMs: latencies.at(-1), tailMs, originalPackets: originals.length, rtxPackets: retransmissions.length, sdpFid: true, originalSequence: sequence };
  } finally {
    wrapper.close(); receiver.close();
    await sleep(100);
  }
}
(async () => {
  const entry = require.resolve('@dank074/discord-video-stream');
  const { WebRtcConnWrapper } = await import(pathToFileURL(path.join(path.dirname(entry), 'client/voice/WebRtcWrapper.js')).href);
  try {
    const results = [];
    for (const codec of ['H264', 'H265']) results.push(await validate(codec, WebRtcConnWrapper));
    console.log(JSON.stringify({ nativePackageVersion: JSON.parse(require('node:fs').readFileSync(path.join(path.dirname(require.resolve('@lng2004/node-datachannel')), '../../../package.json'), 'utf8')).version, libdatachannelVersion: rtc.getLibraryVersion(), results }));
  } finally { rtc.cleanup(); nativeOwners.length = 0; }
})().catch(error => { console.error(error); process.exitCode = 1; });
