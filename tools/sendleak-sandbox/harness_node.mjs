// Node-side-only repro harness (NO Discord / NO voice / NO WebRtcWrapper).
// Drives the REAL LibavDemuxer.demux + the REAL TimedTrack A/V gate, feeding
// the real ffmpeg `-f nut` pipe into a drain sink. Localizes the 2033-byte
// wedge to: (A) demux-never-resolves / no video, (B) TimedTrack A/V gate,
// (C) send call count (outBytes proxy), or (D) main-thread native block.
// Env: MEDIA_URL (required), TQS (default 2048), SECS (default 25)
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { TimedTrack } = require('/Users/alexchomiak/code/10man-discord-bot/src/streambot/persistentTrackFeeder.js');

const URL = process.env.MEDIA_URL;
if (!URL) { console.error('set MEDIA_URL'); process.exit(2); }
const TQS = process.env.TQS || '2048';
const SECS = Number(process.env.SECS || 25);

const T0 = Date.now();
const ts = () => ((Date.now() - T0) / 1000).toFixed(1);
const log = (...a) => console.log(`[${ts()}s]`, ...a);

// ---- spawner: exact production command shape -> pipe:1 ----
const FF = process.env.FF || '/opt/homebrew/bin/ffmpeg';
const args = [
  '-hide_banner', '-loglevel', 'warning',
  '-thread_queue_size', TQS,
  '-rw_timeout', '15000000', '-user_agent', 'Mozilla/5.0',
  '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
  '-i', URL,
  '-f', 'lavfi', '-re', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
  '-ac', '2', '-ar', '48000', '-acodec', 'libopus', '-b:a', '128k', '-filter:a', 'volume=1.0,apad',
  '-r', '30', '-vcodec', 'libx264',
  '-filter:v', 'scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1',
  '-f', 'nut', '-map', '0:v:0', '-map', '1:a:0?', '-fps_mode', 'cfr',
  '-b:v', '5000k', '-maxrate:v', '7000k', '-bufsize:v', '1500k',
  '-bf', '0', '-pix_fmt', 'yuv420p',
  '-shortest', '-force_key_frames', 'expr:gte(t,n_forced*2)', '-forced-idr', '1',
  '-tune', 'film', '-preset', 'superfast', '-y', 'pipe:1'
];
const ff = spawn(FF, args, { stdio: ['ignore', 'pipe', 'inherit'] });
log('spf: launching pid=', ff.pid, 'TQS=', TQS);

// ---- out-of-process heartbeat sampler (ticked independently from in-proc) ----
const samplerTicks = [];
const sampler = spawn(process.execPath, ['-e',
  'const t0=Date.now();setInterval(()=>process.stdout.write("S "+(Date.now()-t0)+"\\n"),150);'
]);
sampler.stdout.on('data', d => {
  for (const l of d.toString().trim().split('\n')) {
    if (!l) continue;
    samplerTicks.push(parseInt(l.split(' ')[1], 10));
    if (samplerTicks.length > 4000) samplerTicks.shift();
  }
});

// in-process heartbeat: if main thread blocked in native call, this stops.
let hbGapMax = 0, lastHb = Date.now();
const hb = setInterval(() => {
  const now = Date.now();
  const gap = now - lastHb;
  if (gap > hbGapMax) hbGapMax = gap;
  lastHb = now;
}, 150);

// ---- probe C: send counters ----
let sentVideo = 0, sentAudio = 0, sentVideoBytes = 0;

const C = { vWrite: 0, aWrite: 0, vPts: null, aPts: null, gateLoops: 0, firstV: null, firstA: null, lastDelta: null };

function counterSend(kind) {
  return (frame, ms) => {
    if (kind === 'video') { sentVideo++; sentVideoBytes += frame.length; }
    else sentAudio++;
  };
}

const video = new TimedTrack(counterSend('video'), 'video', { avGateMs: 20, maxCatchupMs: 250 });
const audio = new TimedTrack(counterSend('audio'), 'audio', { avGateMs: 20, maxCatchupMs: 250 });
video.syncTrack = audio;

// instrument _write for probe B (no semantic change)
const wrap = (t, kind) => {
  const orig = t._write.bind(t);
  t._write = async function (packet, enc, cb) {
    const { pts, duration, timeBase } = packet;
    const p = Number(pts) * timeBase.num * 1000 / timeBase.den;
    if (kind === 'video' && C.firstV === null) { C.firstV = ts(); log('PROBE-A first video _write @', ts()+'s'); }
    if (kind === 'audio' && C.firstA === null) { C.firstA = ts(); log('PROBE-A first audio _write @', ts()+'s'); }
    if (kind === 'video') { C.vWrite++; C.vPts = p; }
    else { C.aWrite++; C.aPts = p; }
    if (C.vPts != null && C.aPts != null) C.lastDelta = C.vPts - C.aPts;
    if (process.env.VERBOSE && kind === 'video' && C.vWrite % 60 === 0)
      log(`PROBE-B v#${C.vWrite} a#${C.aWrite} vpts=${(p|0)}ms apts=${(C.aPts|0)}ms delta=${(C.lastDelta|0)}ms gate=${C.gateLoops}`);
    try { await orig(packet, enc, cb); } catch (e) { cb(e); }
  };
  const oSleep = t.sleep.bind(t);
  t.sleep = async (ms) => { if (kind === 'video' && C.lastDelta > 20) C.gateLoops++; await oSleep(ms); };
};
wrap(video, 'video');
wrap(audio, 'audio');

// ---- drive demux + pipes ----
let demuxMs = null;
// surface the real error the library logs as "{}" (it drops it when it can't serialize)
const _info = console.info;
console.info = (...a) => {
  try {
    const s = JSON.stringify(a).slice(0, 200);
    if (s && /frame extraction|error/i.test(s) && a.length >= 1 && (a[0] && a[0].error || a.some(x => x && /error/i.test(JSON.stringify(x))))) {
      const obj = a[0] && a[0].error;
      const errObj = a[0] && a[0].error && a[0].error.error ? a[0].error.error : obj;
      _info('HARBOR-CAPTURE library error object type=', typeof errObj,
        'name=', errObj && errObj.name,
        'msg=', errObj && errObj.message,
        'ctor=', errObj && errObj.constructor && errObj.constructor.name,
        'stack=', (errObj && errObj.stack || String(errObj)).slice(0, 800));
    }
  } catch {}
  return _info(...a);
};

async function main() {
  const vm = await import('@dank074/discord-video-stream');
  const t = Date.now();
  const media = await vm.demux(ff.stdout, { format: 'nut' });
  demuxMs = Date.now() - t;
  log(`PROBE-A demux RESOLVED in ${demuxMs}ms  video=${media.video?'yes':'NO'}  audio=${media.audio?'yes':'NO'}`);
  if (!media.video) { await finish('no-video'); return; }

  media.video.stream.pipe(video);
  if (media.audio) media.audio.stream.pipe(audio);
  log('pipes attached; waiting for progress window...');

  let lastSends = -1, lastProgressAt = Date.now();
  const iv = setInterval(() => {
    const now = Date.now();
    if (sentVideo + sentAudio !== lastSends) lastProgressAt = now;
    const stall = now - lastProgressAt;
    log(`STATE vSend=${sentVideo} aSend=${sentAudio} vBytes=${sentVideoBytes} vW=${C.vWrite} aW=${C.aWrite} vPts=${C.vPts!=null?(C.vPts|0):'--'} aPts=${C.aPts!=null?(C.aPts|0):'--'} delta=${C.lastDelta!=null?(C.lastDelta|0):'--'} gate=${C.gateLoops} hbMaxGap=${hbGapMax}ms sampN=${samplerTicks.length}`);
    if (sentVideo === 0 || (sentVideo + sentAudio) === lastSends) {
      if (stall > 4500) log(`WEDGE: ${sentVideo === 0 ? 'zero sends' : 'sends froze'} for ${stall}ms; hbMaxGap=${hbGapMax}ms`);
    }
    lastSends = sentVideo + sentAudio;
    if (now - T0 >= SECS * 1000) {
      clearInterval(iv);
      finish(sentVideo < 20 ? 'wedge' : (stall > 4500 ? 'stalled' : 'ok'));
    }
  }, 2000);
  global._ivs = { iv };
}

const VERDICT = {
  'ok': 'VERDICT: Node-side path HEALTHY (sends kept rising to deadline) => block is in real WebRTC/Go-Live egress; run ONE bounded real-bot probe.',
  'wedge': 'VERDICT: Node-side REPRO (sends froze in <25s) => wedge is demux-resolve / A/V gate / native read; investigate here first.',
  'stalled': 'VERDICT: Node-side Degrades (sends then stalled) => A/V gate or producer starvation after a while.',
  'no-video': 'VERDICT: NUT demux OK but no video stream => ffmpeg/map problem, not Node.',
  'main-error': 'VERDICT: harness threw; see MAIN ERROR above.'
};

async function finish(reason) {
  log('FINISH reason=', reason);
  log(`SUMMARY demuxMs=${demuxMs} firstV=${C.firstV} firstA=${C.firstA} vSend=${sentVideo} aSend=${sentAudio} vBytes=${sentVideoBytes} vW=${C.vWrite} aW=${C.aWrite} gate=${C.gateLoops} hbMaxGap=${hbGapMax}ms vPts=${C.vPts} aPts=${C.aPts} delta=${C.lastDelta} sampN=${samplerTicks.length}`);
  log(VERDICT[reason] || reason);
  teardown();
}
function teardown() {
  try { video.destroy(); } catch {}
  try { audio.destroy(); } catch {}
  try { ff.kill('SIGKILL'); } catch {}
  try { sampler.kill('SIGKILL'); } catch {}
  try { clearInterval(global._ivs?.iv); } catch {}
  try { clearInterval(hb); } catch {}
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('exit', teardown);
process.on('SIGINT', teardown);
process.on('SIGTERM', teardown);

main().catch(e => { log('MAIN ERROR', e && e.stack || e); finish('main-error'); });
