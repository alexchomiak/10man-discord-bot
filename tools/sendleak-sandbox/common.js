'use strict';
// Shared helpers for the sendleak sandbox.
// Only uses already-installed packages. No media decoding, no real Discord sockets.
const dc = require('@lng2004/node-datachannel');
const {
  PeerConnection,
  Audio,
  Video,
  H264RtpPacketizer,
  RtpPacketizationConfig,
  RtcpSrReporter,
  RtcpNackResponder,
  PacingHandler,
} = dc;

function waitGather(pc) {
  return new Promise((res) => {
    let i = 0;
    const iv = setInterval(() => {
      if (pc.gatheringState() === 'complete' || ++i > 80) {
        clearInterval(iv);
        res();
      }
    }, 100);
  });
}

function makeAudioDef() {
  const a = new Audio('0', 'SendRecv');
  a.addOpusCodec(120);
  return a;
}
function makeVideoDef() {
  const v = new Video('1', 'SendRecv');
  v.addH264Codec(101);
  v.addRTXCodec(102, 101, 90000);
  return v;
}

// Mirrors WebRtcWrapper.setPacketizer(): H264 + SrReporter + NACK + PacingHandler(25Mbps,1ms).
function attachVideoPacketizer(track) {
  const cfg = new RtpPacketizationConfig(11111, '', 101, 90000);
  const pkt = new H264RtpPacketizer('StartSequence', cfg);
  pkt.addToChain(new RtcpSrReporter(cfg));
  pkt.addToChain(new RtcpNackResponder());
  pkt.addToChain(new PacingHandler(25 * 1000 * 1000, 1));
  track.setMediaHandler(pkt);
  return { pkt, cfg };
}

// Loopback A<->B with real PeerConnections. A is the sender side.
// If killAfterConnect is true, A connects then B is closed (dead/slow receiver) BEFORE
// the caller starts pumping, so the native send/retransmit queue has nothing to drain into.
async function connectLoopback({ killAfterConnect = false } = {}) {
  const A = new PeerConnection('A', { iceServers: [] });
  const B = new PeerConnection('B', { iceServers: [] });
  const at = A.addTrack(makeAudioDef());
  const vt = A.addTrack(makeVideoDef());
  B.addTrack(makeAudioDef());
  B.addTrack(makeVideoDef());

  A.setLocalDescription();
  await waitGather(A);
  const offer = A.localDescription().sdp.replace(/a=setup:actpass/g, 'a=setup:active');
  B.setRemoteDescription(offer, 'offer');
  B.setLocalDescription();
  await waitGather(B);
  const ans = B.localDescription().sdp.replace(/a=setup:actpass/g, 'a=setup:passive');
  A.setRemoteDescription(ans, 'answer');

  let connected = false;
  for (let i = 0; i < 60 && A.state() !== 'connected'; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  connected = A.state() === 'connected';
  if (!connected) throw new Error('loopback did not reach connected (got ' + A.state() + ')');

  attachVideoPacketizer(vt);

  if (killAfterConnect) {
    // Drop the peer so A's frames can neither be ACKed nor retransmitted away.
    B.close();
    A.onStateChange(() => {}); // keep state churn from crashing the process
  }

  return { A, B, audioTrack: at, videoTrack: vt, connected: true };
}

// H.264-ish AnnexB frame: start code + a non-IDR slice NAL header + payload.
function synthesizeFrame(frameBytes) {
  const header = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x41]);
  const body = Math.max(0, frameBytes - header.length);
  const payload = Buffer.alloc(body, 0x10); // filler bytes
  return Buffer.concat([header, payload]);
}

function readVmStat() {
  // macOS only. Returns { free, wired, active, inactive } in BYTES, else null.
  // Page size is read from the vm_stat header because Apple Silicon reports 16384.
  if (process.platform !== 'darwin') return null;
  try {
    const cp = require('child_process');
    const out = cp
      .execFileSync('vm_stat', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n');
    const pageM = out.join('\n').match(/page size of (\d+)/);
    const PAGE = pageM ? parseInt(pageM[1], 10) : 4096;
    const grab = (re) => {
      const line = out.find((l) => re.test(l));
      const m = line && line.match(/(\d+)/);
      return m ? parseInt(m[1], 10) * PAGE : 0;
    };
    return {
      free: grab(/free/),
      wired: grab(/wired/),
      active: grab(/active/),
      inactive: grab(/inactive/),
    };
  } catch (e) {
    return null;
  }
}

// Columns are fixed so A and B share the same shape.
const TSV_HEADER = [
  't_s',
  'rss_bytes',
  'heap_used',
  'external',
  'array_buffers',
  'native_bytes', // rss - heapUsed -> isolates native (non-V8) growth
  'frames_sent',
  'conns_active',
  'vmstat_free_bytes',
  'vmstat_wired_bytes',
];

function makeSampler(tsvPath) {
  const fs = require('fs');
  let fh = null;
  try {
    fs.mkdirSync(require('path').dirname(tsvPath), { recursive: true });
    fh = fs.openSync(tsvPath, 'w');
    fs.writeSync(fh, TSV_HEADER.join('\t') + '\n');
  } catch (e) {
    fh = null;
  }
  function emit(parts) {
    const line = parts.join('\t');
    process.stdout.write(line + '\n');
    if (fh) {
      try {
        fs.writeSync(fh, line + '\n');
      } catch (e) {}
    }
  }
  // parts: [t_s, rss, heapUsed, external, arrayBuffers, framesSent, connsActive]
  function snap(t_s, framesSent, connsActive) {
    const m = process.memoryUsage();
    const vm = readVmStat();
    emit([
      t_s,
      m.rss,
      m.heapUsed,
      m.external,
      m.arrayBuffers,
      m.rss - m.heapUsed,
      framesSent,
      connsActive,
      vm ? vm.free : '',
      vm ? vm.wired : '',
    ]);
  }
  return { snap, TSV_HEADER, close: () => { if (fh) { try { fs.closeSync(fh); } catch (e) {} } } };
}

module.exports = {
  dc,
  PeerConnection,
  Audio,
  Video,
  H264RtpPacketizer,
  RtpPacketizationConfig,
  RtcpSrReporter,
  RtcpNackResponder,
  PacingHandler,
  waitGather,
  makeAudioDef,
  makeVideoDef,
  attachVideoPacketizer,
  connectLoopback,
  synthesizeFrame,
  readVmStat,
  TSV_HEADER,
  makeSampler,
};
