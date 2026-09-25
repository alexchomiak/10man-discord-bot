// Local diagnostic: real FFmpeg -> demux -> paced tracks, with a counting transport.
// No Discord login/network transport. Use finite (<50s) separate A/V fixtures.
// Compare production behavior with --old-shortest, which restores the old flags.
// Sampled RSS guards and a 60s deadline limit this diagnostic; they are not OS
// resource limits or evidence of long-duration memory stability. Requires ps.
// See docs/vod-stall-reproduction.md for measured results and limitations.
const fs = require('node:fs');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const [videoFile, audioFile, comparison] = process.argv.slice(2);
if (!videoFile || !audioFile || (comparison && comparison !== '--old-shortest')) {
  console.error('Usage: node scripts/trace-vod-pipeline.cjs VIDEO_FILE AUDIO_FILE [--old-shortest]');
  process.exit(2);
}
for (const file of [videoFile, audioFile]) fs.accessSync(file, fs.constants.R_OK);
const { StreamManager } = require(root + '/src/streambot/streamManager');
const { PersistentTrackFeeder } = require(root + '/src/streambot/persistentTrackFeeder');
const guard = require(root + '/src/streambot/demuxGuard');
const ff = require(root + '/node_modules/fluent-ffmpeg');
ff.setFfmpegPath(process.env.FFMPEG_PATH || 'ffmpeg');
const mode = comparison ? 'old-shortest' : 'fixed';
const server = http.createServer((req,res) => {
  if (req.url !== '/video' && req.url !== '/audio') { res.writeHead(404).end(); return; }
  const file = req.url === '/video' ? videoFile : audioFile;
  const size = fs.statSync(file).size;
  const match=/bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const start=match?Number(match[1]):0, end=match&&match[2]?Math.min(Number(match[2]),size-1):size-1;
  res.writeHead(match?206:200,{'content-length':end-start+1,'accept-ranges':'bytes',...(match?{'content-range':`bytes ${start}-${end}/${size}`}:{})});
  const input=fs.createReadStream(file,{start,end});input.pipe(res);res.on('close',()=>input.destroy());
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  await guard.ensureTrackerInstalled();
  const vm = await import(root+'/node_modules/@dank074/discord-video-stream/dist/index.js');
  const cfg={streamWidth:1920,streamHeight:1080,streamFrameRate:30,streamBitrate:5000,streamAudioBitrate:128,jitterBufferSec:0,pipelineBufferMb:8};
  const mgr=new StreamManager({token:''},'',cfg);
  const piece={isLive:false,control:new AbortController()};
  const base=`http://127.0.0.1:${server.address().port}`;
  const out=mgr._buildDashMerge({Utils:vm.Utils},base+'/video',base+'/audio',0,null,piece);
  if (comparison) {
    out.command.addOutputOption('-shortest');
    out.command.audioFilters('apad');
  }
  out.command.outputOptions(['-progress','pipe:2','-stats_period','1']);
  let child,ffError,progress={};
  out.command.on('stderr',line=>{const m=/^(frame|out_time_us|speed)=(.*)$/.exec(line);if(m)progress[m[1]]=m[2];});
  out.command.on('start',command=>{child=out.command.ffmpegProc;console.log(command);});
  out.promise.catch(e=>ffError=e.message);
  const stats={video:{n:0,last:null,maxGap:0},audio:{n:0,last:null,maxGap:0}};
  const began=performance.now();
  function send(type){const s=stats[type],now=performance.now();if(s.last!==null){const gap=now-s.last;s.maxGap=Math.max(gap,s.maxGap);if(gap>150) console.log(JSON.stringify({event:'gap',type,at:Math.round((now-began)/1000),gap:Math.round(gap),buffer:out.output.readableLength}));}s.n++;s.last=now;}
  const conn={ready:true,setPacketizer(){},mediaConnection:{setSpeaking(){},setVideoAttributes(){}},sendVideoFrame(){send('video')},sendAudioFrame(){send('audio')}};
  const feeder=new PersistentTrackFeeder({streamer:{createStream:async()=>conn},videoModule:vm});
  const timer=setInterval(()=>{let rss=0;try{rss=Number(execFileSync('ps',['-o','rss=','-p',String(child?.pid)],{encoding:'utf8'}).trim())/1024}catch{};console.log(JSON.stringify({event:'sample',mode,at:Math.round((performance.now()-began)/1000),v:stats.video.n,a:stats.audio.n,ffRssMiB:Math.round(rss),nodeRssMiB:Math.round(process.memoryUsage().rss/1048576),buffer:out.output.readableLength,progress}));if(rss>1000||process.memoryUsage().rss>800*1048576){console.error('Memory guard stopped the trace');process.exitCode=1;piece.control.abort();}},5000);
  const deadline=setTimeout(()=>{console.error('60-second trace deadline reached');process.exitCode=1;piece.control.abort();},60000);
  piece.control.signal.addEventListener('abort',()=>{out.command.kill('SIGKILL');out.output.destroy();});
  try{await mgr._prebuffer(out.output,piece);await feeder.append(out.output,piece.control.signal,undefined,{syncVideoToAudio:piece.isLive});}catch(e){process.exitCode=1;console.log('ERROR',e.code,e.message)}
  finally{clearInterval(timer);clearTimeout(deadline);out.command.kill('SIGKILL');await feeder.close();await guard.closeAllDemuxers();server.closeAllConnections();server.close();console.log(JSON.stringify({event:'done',mode,stats,ffError}));}
})().catch(e=>{console.error(e);server.closeAllConnections();server.close();process.exitCode=1});
