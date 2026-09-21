'use strict';
// repro nut deadlock: ffmpeg NUT pipe -> node-av Demuxer.open(Readable) -> packets()
const { spawn } = require('node:child_process');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { Demuxer } = require('node-av');

const FFMPEG = process.env.FFMPEG || '/opt/homebrew/bin/ffmpeg';
const DUR = Number(process.env.DUR || 6);

async function main() {
  const t0 = Date.now();
  const ff = spawn(FFMPEG, [
    '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc=duration=${DUR}:size=640x360:rate=30`,
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', 
    '-c:a', 'libopus',
    '-shortest',
    '-f', 'nut', '-',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let ffErr = '';
  ff.stderr.on('data', d => { ffErr += d; if (ffErr.length > 4000) ff.stderr.removeAllListeners('data'); });
  const codeP = new Promise((res, rej) => { ff.on('close', c => c === 0 ? res(c) : rej(new Error('ffmpeg exited ' + c + ': ' + ffErr.slice(-400)))); ff.on('error', rej); });

  const input = ff.stdout; // Readable
  const inputBytes = { n: 0 };
  input.on('data', d => { inputBytes.n += d.length; });

  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  const ticker = setInterval(() => {
    const p99 = h.percentile(99) / 1e6;
    process.stdout.write(`[tel] t=${((Date.now()-t0)/1000).toFixed(1)}s in=${(inputBytes.n/1024).toFixed(0)}KiB el_p99_ms=${p99.toFixed(1)}\n`);
  }, 1000);
  ticker.unref();

  try {
    console.log('== Demuxer.open(input, nut) start');
    const demuxer = await Demuxer.open(input, { format: 'nut', bufferSize: 8192, options: { fflags: 'nobuffer' } });
    console.log('== open OK, iterating packets()');
    let n = 0, bytes = 0, last = Date.now();
    const it = demuxer.packets();
    for await (const pkt of it) {
      n++; bytes += pkt.data.length;
      if (Date.now() - last > 2000) { last = Date.now(); console.log(`[pkt] t=${((Date.now()-t0)/1000).toFixed(1)}s n=${n} pkbytes=${(bytes/1024).toFixed(0)}KiB in=${(inputBytes.n/1024).toFixed(0)}KiB`); }
    }
    console.log(`== DONE n=${n} bytes=${bytes} in=${inputBytes.n}`);
    demuxer.close?.();
  } catch (e) {
    console.log('== DEMUX ERROR:', (e && e.message) || e);
    process.exit(4);
  }
  h.disable();
  try { await codeP; console.log('== ffmpeg exited cleanly'); } catch (e) { console.log('== ffmpeg FAILED:', e.message); process.exit(2); }
  process.exit(0);
}

setTimeout(() => { console.log('== TIMED OUT (100s) -- HANG CONFIRMED'); process.exit(3); }, 100000).unref();
main().catch(e => { console.log('== ERROR', (e && e.stack) || e); process.exit(1); });
