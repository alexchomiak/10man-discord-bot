// Bursty-drain reproduction: drain NOTHING for 8s, then drain every available
// byte fast, repeat. If ffmpeg's DECODER thread queue (thread_queue_size) is
// what holds 2048 x 1080p frames, ffmpeg RSS will spike to several GB in the
// 8s-idle windows. Compare TQS=2048 vs TQS=64 vs TQS=1.
const { spawn, execSync } = require('child_process');
const URL = process.env.MEDIA_URL;
const TQS = process.env.TQS || '2048';
const FFM = '/opt/homebrew/bin/ffmpeg';
const ff = spawn(FFM, [
  '-hide_banner','-loglevel','error','-thread_queue_size',TQS,
  '-rw_timeout','15000000','-user_agent','Mozilla/5.0','reconnect','1','reconnect_streamed','1','reconnect_delay_max','5','-i', URL,
  '-f','lavfi','-re','-i','anullsrc=channel_layout=stereo:sample_rate=48000',
  '-ac','2','-ar','48000','-acodec','libopus','-b:a','128k','-filter:a','volume=1.0,apad','-r','30',
  '-vcodec','libx264','-filter:v','scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1',
  '-f','nut','-map','0:v:0','-map','1:a:0?','-fps_mode','cfr','-b:v','5000k','-maxrate:v','7000k','-bufsize:v','1500k',
  '-bf','0','-pix_fmt','yuv420p','-shortest','-force_key_frames','expr:gte(t,n_forced*2)','-forced-idr','1','tune','film','preset','superfast','-y','pipe:1'
]);
const out = [];
ff.stdout.on('data', c => out.push(c));
let total = 0, peakRSS = 0;
const T0 = Date.now();
const iv = setInterval(() => {
  let rssKB=0, cpu='?';
  try { const s = execSync(`ps -o rss=,%cpu= -p ${ff.pid}`).toString().trim().split(/\s+/); rssKB=+s[0]; cpu=s[1]; } catch {}
  const el = ((Date.now()-T0)/1000).toFixed(0);
  // bursty: drain all every 4s, else leave it
  const now = Date.now();
  if ((now % 8000) < 4000) {
    let n=0; while (n<200) { const c = ff.stdout.read(1<<20) ; if (c==null) break; total+=c.length; n+=c.length; }
  }
  if (rssKB>peakRSS) peakRSS=rssKB;
  console.log(`TQS=${TQS} t=${el}s outMB=${(total/1048576).toFixed(2)} ff_rss_MB=${(rssKB/1024).toFixed(0)} peakRSS_MB=${(peakRSS/1024).toFixed(0)} cpu=${cpu}%`);
}, 1500);
setTimeout(()=>{ try{clearInterval(iv);}catch{} try{ff.kill('SIGKILL');}catch{} console.log(`RESULT TQS=${TQS} peakRSS_MB=${(peakRSS/1024).toFixed(0)} totalMB=${(total/1048576).toFixed(2)}`); process.exit(0); }, 24000);
