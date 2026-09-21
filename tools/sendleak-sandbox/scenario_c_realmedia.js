'use strict';
// Scenario C: the user's actual killer file (Jellyfin item-download, HEVC source,
// 1080p) re-encoded by ffmpeg to H.264 and pumped through the production sender
// chain into a receiver PC that never drains.
//
//   ARM=old         (default): fire-and-forget sendMessageBinary on every AU,
//                              return value discarded, throws caught only to keep
//                              the process alive (the ONLY deviation from the
//                              pre-fix production send path) -> sendThrows column.
//   ARM=supervisor: same pump, but src/streambot/sendSupervisor.js is wired in:
//                              getPC -> native PC, tickFeed on each successful
//                              send, noteSendError on throw, onStall -> stop
//                              pump + pc.close() + fresh PC pair (rejoin) +
//                              resume, onFatal -> FATAL line + clean exit 0.
//
// Env:
//   MEDIA_URL             (required) the media to stream
//   SBOT_DURATION_SEC     default 600 (ffmpeg -t SBOT_DURATION_SEC + 60)
//   SBOT_ARM              "old" | "supervisor" (default old)
//   SBOT_SEND_STALL_SEC   default 5
//   SBOT_RECYCLE_MAX      default 3
//   SBOT_RSS_CAP_BYTES    default 8 GiB; the script SIGKILLs itself if RSS
//                         exceeds this (safety.sh's RSS watchdog compares ps-KiB
//                         RSS against a bytes threshold, so it cannot trip at
//                         8 GiB on macOS; this self-cap makes the 8 GiB ceiling
//                         effective and maps to VERDICT: KILLED_BY_ULIMIT).

const path = require('path');
const { spawn } = require('child_process');
const common = require('./common');
const {
  PeerConnection,
  waitGather,
  makeAudioDef,
  makeVideoDef,
  attachVideoPacketizer,
} = common;

const MEDIA_URL = process.env.MEDIA_URL;
const ARM = process.env.SBOT_ARM || 'old';
if (ARM !== 'old' && ARM !== 'supervisor') {
  process.stderr.write('SBOT_ARM must be "old" or "supervisor" (got ' + ARM + ')\n');
  process.exit(2);
}
if (!MEDIA_URL) {
  process.stderr.write('MEDIA_URL env is required\n');
  process.exit(2);
}

const DURATION_SEC = parseInt(process.env.SBOT_DURATION_SEC || '600', 10);
const STALL_SEC = parseInt(process.env.SBOT_SEND_STALL_SEC || '5', 10);
const RECYCLE_MAX = parseInt(process.env.SBOT_RECYCLE_MAX || '3', 10);
const RSS_CAP_BYTES = parseInt(process.env.SBOT_RSS_CAP_BYTES || String(8 * 1024 * 1024 * 1024), 10);
const ARM_LABEL = ARM === 'supervisor' ? 'supervisor' : 'old';
const TSV = process.env.SBOT_TSV || path.join(__dirname, 'out', 'scenario_c_' + ARM_LABEL + '.tsv');

const { createSendSupervisor } = require('../../src/streambot/sendSupervisor.js');

let pcGen = 0;
async function createSender() {
  pcGen += 1;
  const A = new PeerConnection('A' + pcGen, { iceServers: [] });
  const B = new PeerConnection('B' + pcGen, { iceServers: [] });
  A.addTrack(makeAudioDef());
  const videoTrack = A.addTrack(makeVideoDef());
  B.addTrack(makeAudioDef());
  B.addTrack(makeVideoDef());
  A.setLocalDescription();
  await waitGather(A);
  const offer = A.localDescription()
    .sdp.replace(/a=setup:actpass/g, 'a=setup:active');
  B.setRemoteDescription(offer, 'offer');
  B.setLocalDescription();
  await waitGather(B);
  const ans = B.localDescription()
    .sdp.replace(/a=setup:actpass/g, 'a=setup:passive');
  A.setRemoteDescription(ans, 'answer');
  let ok = false;
  for (let i = 0; i < 80 && A.state() !== 'connected'; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  ok = A.state() === 'connected';
  if (!ok) {
    A.close();
    B.close();
    throw new Error('loopback did not reach connected (got ' + A.state() + ')');
  }
  attachVideoPacketizer(videoTrack);
  return { A, B, videoTrack };
}

// --- AnnexB access-unit parser ---------------------------------------------
// Buffers ffmpeg's `-f h264` stdout and splits on 00 00 01 / 00 00 00 01
// start codes. An access unit is one group of NALs ending at the first
// VCL NAL (type 1..5); the group is emitted when the NEXT NAL starts
// (or at flush()). A NAL whose type byte is not yet buffered keeps
// the group pending.
function makeAuParser() {
  const START = Buffer.from([0x00, 0x00, 0x01]);
  let buf = Buffer.alloc(0);
  let pos = -1; // start-code offset of the current NAL's group head
  let vcl = null; // true/false/null (unknown) for the CURRENT NAL

  function vclAt(i) {
    if (buf.length === 0) return null;
    const t = buf[i] & 0x1f;
    return t >= 1 && t <= 5;
  }

  function feed(chunk) {
    if (chunk && chunk.length) buf = Buffer.concat([buf, chunk]);
    const out = [];
    if (pos < 0) {
      pos = buf.indexOf(START);
      if (pos === -1) {
        if (buf.length > 8 * 1024 * 1024) {
          // guard: 8 MiB with no start code is not a valid h264 stream
          out.push(buf);
          buf = Buffer.alloc(0);
          vcl = null;
        }
        return out;
      }
      vcl = vclAt(pos + 3);
    }
    for (;;) {
      const p = buf.indexOf(START, pos + 3);
      if (p === -1) break;
      if (vcl === null) vcl = vclAt(pos + 3);
      if (vcl === true) {
        out.push(buf.slice(pos, p));
        pos = p;
        vcl = vclAt(p + 3);
      } else {
        pos = p;
        vcl = vclAt(p + 3);
      }
    }
    return out;
  }

  function flush() {
    let extra = null;
    if (pos >= 0) {
      if (vcl !== false) extra = buf.slice(pos);
      pos = -1;
      buf = Buffer.alloc(0);
      vcl = null;
    }
    return extra;
  }

  return { feed, flush };
}

// --- TSV sampler -------------------------------------------------------------
function openSampler(cols) {
  const fs = require('fs');
  fs.mkdirSync(path.dirname(TSV), { recursive: true });
  const fh = fs.openSync(TSV, 'w');
  fs.writeSync(fh, cols.join('\t') + '\n');
  function row(a) {
    const line = a.join('\t');
    process.stdout.write(line + '\n');
    try {
      fs.writeSync(fh, line + '\n');
    } catch (e) {}
  }
  return {
    row,
    close() {
      try {
        fs.closeSync(fh);
      } catch (e) {}
    },
  };
}

// --- main --------------------------------------------------------------------
async function main() {
  const t0 = Date.now();
  process.stdout.write(
    'C: arm=' + ARM_LABEL + ' duration=' + DURATION_SEC + 's stallSec=' + STALL_SEC +
      ' recycleMax=' + RECYCLE_MAX + ' rssCap=' + RSS_CAP_BYTES + ' tsv=' + TSV + '\n'
  );

  let sender = await createSender();
  process.stdout.write('C: connected gen=' + pcGen + ' maxMessageSize=' + sender.videoTrack.maxMessageSize() + '\n');

  const cols =
    ARM === 'supervisor'
      ? ['t_s', 'rss_bytes', 'heap_used', 'external', 'array_buffers', 'native_bytes', 'frames_sent', 'recycles', 'sendThrows']
      : ['t_s', 'rss_bytes', 'heap_used', 'external', 'array_buffers', 'native_bytes', 'frames_sent', 'sendThrows'];
  const sampler = openSampler(cols);

  let framesSent = 0;
  let sendThrows = 0;
  let recycles = 0;
  let pumping = true;
  let recycling = false;
  let fatal = false;
  let shuttingDown = false;

  function rssCheck() {
    const rss = process.memoryUsage().rss;
    if (rss > RSS_CAP_BYTES) {
      process.stdout.write('C: RSS_CAP_EXCEEDED rss=' + rss + ' cap=' + RSS_CAP_BYTES + ' -> SIGKILL self\n');
      process.stdout.flush && process.stdout.flush();
      process.kill(process.pid, 'SIGKILL');
    }
    return rss;
  }

  function snap() {
    const m = process.memoryUsage();
    const rss = m.rss;
    if (ARM === 'supervisor') sampler.row([
      ((Date.now() - t0) / 1000).toFixed(2),
      m.rss, m.heapUsed, m.external, m.arrayBuffers, rss - m.heapUsed,
      framesSent, recycles, sendThrows,
    ]);
    else sampler.row([
      ((Date.now() - t0) / 1000).toFixed(2),
      m.rss, m.heapUsed, m.external, m.arrayBuffers, rss - m.heapUsed,
      framesSent, sendThrows,
    ]);
    return rssCheck();
  }

  const timer = setInterval(() => { if (!shuttingDown) snap(); }, 2000);
  snap();

  const noop = () => {};
  const sup =
    ARM === 'supervisor'
      ? createSendSupervisor({
          getPC: () => (sender ? sender.A : null),
          config: { stallSec: STALL_SEC, recycleMax: RECYCLE_MAX, tickMs: 1000 },
          onStall: () => {
            if (recycling || fatal) return;
            recycling = true;
            pumping = false;
            process.stdout.write('C: SUPERVISOR onStall -> stop pump, close pc, rejoin (recycle ' + (recycles + 1) + ')\n');
            (async () => {
              try {
                if (sender) {
                  sender.A.close();
                  sender.B.close();
                }
              } catch (e) {}
              sender = null;
              const fresh = await createSender();
              sender = fresh;
              recycles += 1;
              // Re-arm the supervisor against the fresh PC: a native PC's
              // bytesSent() restarts low and, in the never-drains mode, stays
              // flat. Without this the supervisor is latched at 'stalled' and
              // its `state === 'ok'` gate blocks onStall #2 forever (the
              // verified recycle-stall failure). resetBaseline clears the
              // lastBytes / zeroTicks / feedWindow baselines and re-arms the
              // latch while PRESERVING recycleStamps (the escalation count).
              try { sup.resetBaseline(); } catch (e) {}
              process.stdout.write(
                'C: SUPERVISOR rejoined gen=' + pcGen + ' recycles=' + recycles +
                  ' supState=' + sup.state + ' supRecycles=' + sup.recycles +
                  ' rss=' + process.memoryUsage().rss + '\n'
              );
              recycling = false;
              pumping = !fatal && !shuttingDown;
            })().catch((e) => {
              process.stdout.write('C: SUPERVISOR rejoin FATAL ' + (e && (e.stack || e.message) || e) + '\n');
              fatal = true;
              pumping = false;
              recycling = false;
            });
          },
          onFatal: () => {
            fatal = true;
            pumping = false;
            process.stdout.write('C: SUPERVISOR onFatal state=' + sup.state + ' recycles=' + sup.recycles + ' rss=' + process.memoryUsage().rss + '\n');
            process.stdout.flush && process.stdout.flush();
          },
        })
      : { tickFeed: noop, noteSendError: noop, resetBaseline: noop, close: noop };

  function cleanup() {
    if (shuttingDown) return;
    shuttingDown = true;
    pumping = false;
    try {
      sup.close();
    } catch (e) {}
    try {
      if (sender) {
        sender.A.close();
        sender.B.close();
      }
    } catch (e) {}
    try {
      child.kill('SIGKILL');
    } catch (e) {}
    try {
      clearInterval(timer);
    } catch (e) {}
    sampler.close();
    process.exit(0);
  }
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  process.on('exit', () => {
    try {
      child.kill('SIGKILL');
    } catch (e) {}
  });
  process.on('uncaughtException', (e) => {
    const rss = process.memoryUsage().rss;
    process.stderr.write('C: UNCAUGHT ' + (e && (e.stack || e.message) || e) + ' rss=' + rss +
      ' framesSent=' + framesSent + ' sendThrows=' + sendThrows + ' recycles=' + recycles + '\n');
    process.exit(1);
  });

  // --- ffmpeg: the SAME media, re-encoded to H.264 AnnexB on stdout ---
  const child = spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel', 'error',
      '-rw_timeout', '15000000',
      '-re', // produce at source (realtime) fps, exactly like a live feed; the
            // pump loop also paces this side at the source fps (see below)
      '-i', MEDIA_URL,
      '-t', String(DURATION_SEC + 60),
      '-vf', 'scale=1920:1080',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-b:v', '8000k',
      '-maxrate', '8000k',
      '-pix_fmt', 'yuv420p',
      '-f', 'h264',
      '-',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  process.stdout.write('C: ffmpeg pid=' + child.pid + ' started (-t ' + (DURATION_SEC + 60) + ')\n');

  let childExited = false;
  child.on('error', (e) => {
    process.stderr.write('C: FATAL ffmpeg spawn error ' + (e && e.message || e) + '\n');
    childExited = true;
  });
  child.on('exit', (code) => {
    childExited = true;
    process.stdout.write('C: ffmpeg exited code=' + code + '\n');
  });

  const parser = makeAuParser();

  // The source media is ~23.976 fps (see probe). A live Discord capture delivers
  // frames decode-paced at the source rate, so we pump ONE AU per tick at
  // SOURCE_FPS. This mirrors the un-throttled production sender (WebRtcWrapper
  // sendVideoFrame is called once per decoded frame at realtime) WITHOUT
  // over-pumping the native queue the way an un-paced fire-hose would.
  const SOURCE_FPS = 24;
  const TICK_MS = Math.round(1000 / SOURCE_FPS);

  const queue = []; // AUs produced by ffmpeg but not yet pumped
  let auReceived = 0;
  let sendFalse = 0; // sendMessageBinary returned false (queued/rejected by native)
  let auMaxBytes = 0;

  // ffmpeg data -> AnnexB AUs -> queue (no send here; the pump loop below paces them).
  child.stdout.on('data', (chunk) => {
    const aus = parser.feed(chunk);
    for (const au of aus) {
      auReceived += 1;
      if (au.length > auMaxBytes) auMaxBytes = au.length;
      if (queue.length < 4096) queue.push(au); // bounded ring; drop oldest if absurdly backed up
      else queue.shift();
    }
    rssCheck();
  });
  child.stdout.on('error', (e) => {
    process.stderr.write('C: ffmpeg stdout error ' + (e && e.message || e) + '\n');
  });

  // Paced send loop: one AU per tick at SOURCE_FPS.
  const pump = setInterval(() => {
    if (shuttingDown || fatal) return;
    if (!pumping || !sender) return;
    const au = queue.shift();
    if (!au) return;
    framesSent += 1; // count every API attempt, like scenario A
    try {
      const r = sender.videoTrack.sendMessageBinary(au); // return value discarded, like production
      if (r === false) sendFalse += 1;
      sup.tickFeed();
    } catch (e) {
      sendThrows += 1;
      if (sendThrows <= 3) process.stdout.write('C: SEND_THROW #' + sendThrows + ' ' + (e && (e.message || e)) + '\n');
      sup.noteSendError();
    }
    rssCheck();
  }, TICK_MS);

  function stopPump() {
    try {
      clearInterval(pump);
    } catch (e) {}
  }

  // Run until ffmpeg closes (its -t cap), OR the supervisor goes fatal, OR the backstop.
  await new Promise((resolve) => {
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(cap);
      clearInterval(watch);
      resolve();
    };
    let settled = false;
    const watch = setInterval(() => { if (fatal || shuttingDown) settle(); }, 200);
    child.on('exit', () => setTimeout(settle, 50));
    const cap = setTimeout(settle, (DURATION_SEC + 120) * 1000);
  }).finally(() => {
    // Flush any trailing trailing AU that was fully parsed.
    const tail = parser.flush();
    if (tail && !fatal && !shuttingDown && pumping && sender) {
      queue.unshift(tail);
    }
    // Drain whatever is left in the queue (bounded) so framesSent reflects work done.
    while (queue.length && !fatal && !shuttingDown && pumping && sender) {
      const au = queue.shift();
      try {
        sender.videoTrack.sendMessageBinary(au);
        framesSent += 1;
        sup.tickFeed();
      } catch (e) {
        sendThrows += 1;
        sup.noteSendError();
      }
    }
    stopPump();
  });

  const elapsedS = (Date.now() - t0) / 1000;
  const m = process.memoryUsage();
  const rss = m.rss;
  const fps = framesSent > 0 ? (framesSent / elapsedS).toFixed(3) : '0';
  let stateLine = 'natural end (ffmpeg finished)';
  if (fatal && ARM === 'supervisor') stateLine = 'FATAL escalation (recycles exceeded recycleMax)';
  process.stdout.write(
    'C: END arm=' + ARM_LABEL + ' elapsed=' + elapsedS.toFixed(1) + 's frames=' + framesSent +
      ' fps=' + fps + ' auReceived=' + auReceived + ' auMaxBytes=' + auMaxBytes +
      ' sendThrows=' + sendThrows + ' sendFalse=' + sendFalse + ' recycles=' + recycles +
      ' rss=' + rss + '(' + (rss / 1048576).toFixed(1) + 'MiB) native=' + (rss - m.heapUsed) +
      ' heapUsed=' + m.heapUsed + ' state=' + stateLine + '\n'
  );
  sampler.row([
    'end',
    rss, m.heapUsed, m.external, m.arrayBuffers, rss - m.heapUsed,
    framesSent, ARM === 'supervisor' ? recycles : '', sendThrows,
  ]);

  cleanup();
}

main().catch((e) => {
  process.stderr.write('C: FATAL ' + (e && (e.stack || e.message) || e) + '\n');
  process.exit(1);
});
