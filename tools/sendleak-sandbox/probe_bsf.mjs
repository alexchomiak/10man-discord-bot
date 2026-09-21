// Focused: feed real NUT pipe to node-av Demuxer, then run the SAME
// BitStreamFilterAPI chain H264 (h264_mp4toannexb -> h264_metadata -> dump_extra)
// on the first few packets, catching which filter throws + its real cause.
import { spawn } from 'node:child_process';
const URL = process.env.MEDIA_URL;
const FF = process.env.FF || '/opt/homebrew/bin/ffmpeg';
const args = [
  '-hide_banner','-loglevel','warning','-thread_queue_size','2048',
  '-reconnect','1','-reconnect_streamed','1','-reconnect_delay_max','5','-i',URL,
  '-f','lavfi','-re','-i','anullsrc=channel_layout=stereo:sample_rate=48000',
  '-ac','2','-ar','48000','-acodec','libopus','-b:a','128k','-filter:a','volume=1.0,apad',
  '-r','30','-vcodec','libx264',
  '-filter:v','scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1',
  '-f','nut','-map','0:v:0','-map','1:a:0?','-fps_mode','cfr','-b:v','5000k','-maxrate:v','7000k','-bufsize:v','1500k',
  '-bf','0','-pix_fmt','yuv420p','-shortest','-force_key_frames','expr:gte(t,n_forced*2)','-forced-idr','1',
  '-tune','film','-preset','superfast','-y','pipe:1'];
const ff = spawn(FF, args, { stdio: ['ignore','pipe','inherit'] });
const log = (...a) => console.log('[P]', ...a);
const { Demuxer, BitStreamFilterAPI } = await import('node-av');

const dem = await Demuxer.open(ff.stdout, { options: { fflags: 'nobuffer' }, format: 'nut', bufferSize: 8192 });
log('Demuxer.open resolved');
const vStream = dem.video();
if (!vStream) { log('NO video stream'); process.exit(3); }
log('video stream codecId=', vStream.codecpar && vStream.codecpar.codecId);

const filters = [
  BitStreamFilterAPI.create('h264_mp4toannexb', vStream),
  BitStreamFilterAPI.create('h264_metadata', vStream, { options: { aud: 'remove' } }),
  BitStreamFilterAPI.create('dump_extra', vStream),
];
log('3 BitStreamFilters created');

const it = dem.packets();
let n = 0, firstSeen = false;
try {
  while (true) {
    const { value: pkt, done } = await it.next();
    if (done) break;
    if (!pkt) continue;
    try {
      if (pkt.streamIndex === vStream.index) {
        n++;
        log(`video pkt#${n} dataLen=${pkt.data && pkt.data.length} pts=${pkt.pts} dur=${pkt.duration}`);
        if (!firstSeen) {
          firstSeen = true;
          // Walk the filter chain on a clone
          let cur = pkt.clone();
          for (const [i, f] of filters.entries()) {
            log(`  entering filter[${i}]`);
            const outs = await f.filterAll(cur);
            cur.free?.();
            log(`  filter[${i}] OK outN=${outs.length} sizes=${outs.map(o => (o && o.data && o.data.length) || 0)}`);
            cur = outs[0] ? outs[0].clone() : null;
            try { if (outs[0]) outs[0].free?.(); } catch {}
            if (!cur) break;
          }
        }
      }
    } finally {
      try { pkt.free(); } catch {}
      if (n >= 3) break;
    }
  }
} catch (e) {
  log('EXC outer:', e && e.name, '-', e && e.message);
  log('  cause:', e && e.cause ? (e.cause.message || e.cause.name || String(e.cause)) : 'n/a');
  log('  stack:', (e && e.stack || 'n/a').split('\n').slice(0, 8).join(' | ').slice(0, 1500));
}
filters.forEach(f => { try { f.close(); } catch {} });
try { dem.close(); } catch {}
try { ff.kill('SIGKILL'); } catch {}
log('done');
process.exit(0);
