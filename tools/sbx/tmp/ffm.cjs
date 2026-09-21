const ff = require('fluent-ffmpeg');
const { PassThrough } = require('stream');
const out = new PassThrough();
const cmd = ff(process.env.MEDIA_URL);
if (typeof cmd.availableFormats === 'function') {
  const af = cmd.availableFormats.bind(cmd);
  cmd.availableFormats = (cb) => af((err, formats) => {
    if (!err && formats && !formats.lavfi) formats.lavfi = { description: 'libavfilter', canDemux: true, canMux: false };
    cb(err, formats);
  });
}
cmd.inputOptions(['-thread_queue_size','2048','-rw_timeout','15000000','-user_agent','Mozilla/5.0','-reconnect','1','-reconnect_streamed','1','-reconnect_delay_max','5']);
cmd.input('anullsrc=channel_layout=stereo:sample_rate=48000').inputOptions(['-f','lavfi','-re']);
cmd.output('pipe:1').outputFormat('nut')
  .audioChannels(2).audioFrequency(48000).audioCodec('libopus').audioBitrate('128k').addOutputOption('-lfe_mix_level','1')
  .audioFilters('volume@internal_lib=1.0,apad')
  .addOutputOption('-map 0:v:0').addOutputOption('-map 0:a:0?')
  .videoFilter('scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1')
  .fpsOutput(30).addOutputOption(['-fps_mode','cfr','-b:v','5000k','-maxrate:v','7000k','-bufsize:v','1500k','-bf','0','-pix_fmt','yuv420p'])
  .addOutputOption('-map 1:a:0').addOutputOption('-shortest').addOutputOption('-force_key_frames','expr:gte(t,n_forced*2)')
  .videoCodec('libx264').addOutputOption('-preset','superfast').addOutputOption('-tune','film').addOutputOption('-forced-idr','1');
console.error('ARRAY: ' + JSON.stringify((cmd.getCommandArray ? cmd.getCommandArray() : cmd._command || [])).replace(process.env.MEDIA_URL, '<URL>'));
let stderr=''; cmd.on('stderr', d=>{ stderr+=d.toString(); });
cmd.on('error', e => console.error('FFM_ERR', e && e.message));
out.on('data', ()=>{});
out.resume();
let bytes=0; out.on('data', d=>bytes+=d.length);
let lastBytes=0;
const iv = setInterval(()=>{
  const rss = process.memoryUsage ? '' : '';
  console.error(`t+${Math.round((Date.now()-t0)/1000)}s bytes=${bytes}`);
}, 5000);
const t0 = Date.now();
setTimeout(()=>{ console.error('T50 done bytes=', bytes); console.error('STDERR_TAIL:\n'+stderr.split(/\r?\n/).slice(-12).join('\n')); process.exit(0); }, 50000);
cmd.pipe? cmd.pipe(out) : null;
setTimeout(()=>{ try { cmd.pipe(out); } catch(e) { console.error('pipe err', e.message); } cmd.run(); }, 10);
