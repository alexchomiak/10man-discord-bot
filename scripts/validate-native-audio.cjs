'use strict';
// Localhost regression check using the same negotiate-before-packetizer order
// as Discord voice connections. No Discord account or external service needed.
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { setTimeout: sleep } = require('node:timers/promises');
const rtc = require('@lng2004/node-datachannel');
const owners = [];
async function until(predicate, label) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timeout: ${label}`);
    await sleep(10);
  }
}
(async () => {
  const entry = require.resolve('@dank074/discord-video-stream');
  const { WebRtcConnWrapper } = await import(pathToFileURL(path.join(path.dirname(entry), 'client/voice/WebRtcWrapper.js')));
  const wrapper = new WebRtcConnWrapper({ webRtcParams: { audioSsrc: 41, videoSsrc: 42, rtxSsrc: 43 }, daveReady: false });
  const first = wrapper.initWebRtc();
  owners.push(first, wrapper._audioTrack, wrapper._videoTrack);
  first.close();
  const sender = wrapper.initWebRtc();
  const receiver = new rtc.PeerConnection('music-audio-regression', { iceServers: [] });
  owners.push(wrapper, receiver);
  const packets = [];
  let audioTrack, offer;
  try {
    receiver.onTrack(track => {
      owners.push(track);
      if (track.mid() !== '0') return;
      audioTrack = track;
      track.onMessage(packet => {
        if (Buffer.isBuffer(packet) && packet.length >= 12 && (packet[1] & 127) === 120)
          packets.push(Buffer.from(packet));
      });
    });
    sender.onLocalDescription((sdp, type) => { offer = sdp; receiver.setRemoteDescription(sdp, type); });
    receiver.onLocalDescription((sdp, type) => sender.setRemoteDescription(sdp, type));
    sender.onLocalCandidate((candidate, mid) => receiver.addRemoteCandidate(candidate, mid));
    receiver.onLocalCandidate((candidate, mid) => sender.addRemoteCandidate(candidate, mid));
    sender.setLocalDescription();
    await until(() => wrapper.ready && audioTrack?.isOpen(), 'voice handshake');
    wrapper.setPacketizer('H265');
    wrapper._audioPacketizer.rtpConfig.timestamp = 0;
    const opus = Buffer.from([0xf8, 0xff, 0xfe]);
    for (let i = 0; i < 3; i++) wrapper.sendAudioFrame(opus, 20);
    await until(() => packets.length === 3, 'three voice Opus RTP packets');
    assert.equal((offer.match(/a=ssrc:41(?:[ \r\n])/g) || []).length, 1, 'reconnect must advertise audio SSRC once');
    assert.deepEqual(packets.map(packet => packet.readUInt32BE(8)), [41, 41, 41]);
    assert.deepEqual(packets.map(packet => packet.readUInt32BE(4)), [0, 960, 1920]);
    for (const packet of packets) {
      let offset = 12 + (packet[0] & 15) * 4;
      if (packet[0] & 16) offset += 4 + packet.readUInt16BE(offset + 2) * 4;
      assert.deepEqual(packet.subarray(offset), opus);
    }
    console.log('Music Mode voice transport: 3 Opus RTP packets delivered');
  } finally {
    wrapper.close(); receiver.close();
    await sleep(100);
    rtc.cleanup(); owners.length = 0;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
