// Faithful fluent-ffmpeg repro of streamManager._buildDashMerge for a
// video-only mkv (audioUrl = null → anullsrc second input).
const ff = require('fluent-ffmpeg');
const { PassThrough } = require('stream');
const url = process.env.MEDIA_URL;
if (!url) { console.error('need MEDIA_URL'); process.exit(2); }

const out = new PassThrough({ highWaterMark: 8 * 1024 * 1024 });

const command = ff(url);
if (typeof command.availableFormats === 'function') {
  const af = command.availableFormats.bind(command);
  command.availableFormats = (cb) => af((err, formats) => {
    if (!err && formats && !formats.lavfi) formats.lavfi = { description: 'libavfilter', canDemux: true, canMux: false };
    cb(err, formats);
  });
}
command.inputOptions([
  '-thread_queue_size','2048','-rw_timeout','15000000','-user_agent','Mozilla/5.0',
  '-reconnect','1','-reconnect_streamed','1','-reconnect_delay_max','5'
]);
command.input('anullsrc=channel_layout=stereo:sample_rate=48000').inputOptions(['-f','lavfi','-re']);

command.output(out).outputFormat('nut')
  .audioChannels(2).audioFrequency(48000).audioCodec('libopus').audioBitrate('128k')
  .addOutputOption('-lfe_mix_level','1')
  .audioFilters('volume@internal_lib=1.0,apad')
  .addOutputOption('-map 0:v:0')
  .addOutputOption('-map 0:a:0?')
  .videoFilter('scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1')
  .fpsOutput(30)
  .addOutputOption(['-fps_mode','cfr','-b:v','5000k','-maxrate:v','7000k','-bufsize:v','1500k','-bf','0','-pix_fmt','yuv420p'])
  .addOutputOption('-map 1:a:0')
  .addOutputOption('-shortest')
  .addOutputOption('-force_key_frames','expr:gte(t,n_forced*2)')
  .videoCodec('libx264')
  .addOutputOption('-preset','superfast')
  .addOutputOption('-tune','film')
  .addOutputOption('-forced-idr','1');

// drain the passthrough — this is what the bot's MeteredPassThrough equivalent does
let bytes = 0;
out.on('data', d => bytes += d.length);
out.on('end', () => console.error('OUT_END bytes=', bytes));
out.on('error', e => console.error('OUT_ERR', e && e.message));
out.resume();

let stderr = '';
command.on('stderr', d => { stderr += d.toString(); });
command.on('error', e => console.error('FFM_ERR', e && (e.message || e)));
command.on('end', () => console.error('FFM_END'));

console.error('ARRAY:', JSON.stringify((typeof command.getCommandArray === 'function' ? command.getCommandArray() : (command._command || [])).map(t => t === url ? '<URL>' : t)));

const t0 = Date.now();
const iv = setInterval(() => {
  const rss = require('child_process').execSync(`ps -o rss= -p ${process.pid}`, {encoding:'utf8'}).trim();
  console.error(`t+${Math.round((Date.now()-t0)/1000)}s bytes=${bytes} rss_kb=${rss}`);
}, 2000);

setTimeout(() => {
  console.error('T45_FINAL bytes=', bytes);
  console.error('STDERR_TAIL:');
  console.error(stderr.split(/\r?\n/).slice(-30).join('\n').replace(url, '<URL>'));
  process.exit(0);
}, 45000);

try { command.run(); } catch (e) { console.error('RUN_THROW', e); process.exit(1); }
