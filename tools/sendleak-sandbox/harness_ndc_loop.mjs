// Decisive non-Discord probe: run the REAL production send path
//   ffmpeg -f nut -> LibavDemuxer.demux -> TimedTrack -> WebRtcConnWrapper.sendVideoFrame
// but point the WebRtc at an in-process LOOPBACK PeerConnection pair
// (sender -> H264RtpPacketizer -> PacingHandler -> receiver track).
// Compare DRAINED receiver vs UNDRAINED receiver. Watch:
//   - in-process heartbeat gap (main-thread block in native send?)
//   - process RSS (does the send queue grow unbounded like the 9GB case?)
//   - sendVideo call count (did frames even pass TimedTrack?)
// Env: MEDIA_URL (req), SECS (default 25), MODE=drain|nodrain (default drain)
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { TimedTrack } = require('/Users/alexchomiak/code/10man-discord-bot/src/streambot/persistentTrackFeeder.js');
const ndc = require('@lng2004/node-datachannel');

const URL = process.env.MEDIA_URL;
if (!URL) { console.error('set MEDIA_URL'); process.exit(2); }
const SECS = Number(process.env.SECS || 25);
const MODE = process.env.MODE || 'drain';
const T0 = Date.now();
const log = (...a) => console.log(`[${((Date.now()-T0)/1000).toFixed(1)}s][${MODE}]`, ...a);

// ---- ffmpeg same production shape -> pipe:1 ----
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
const ff = spawn('/opt/homebrew/bin/ffmpeg', args, { stdio: ['ignore','pipe','inherit'] });
log('ff launched pid=', ff.pid);

// ---- main-thread heartbeat ----
let hbGapMax=0,lastHb=Date.now();
const hb=setInterval(()=>{const n=Date.now();const g=n-lastHb;if(g>hbGapMax)hbGapMax=g;lastHb=n;},100);
const rssNow=()=>{try{return require('node:fs').readFileSync('/proc/self/status','utf8')}catch{} return process.memoryUsage().rss};
const rssMB=()=>Math.round(process.memoryUsage().rss/1048576);

// ---- loopback peer connections ----
const sender = new ndc.PeerConnection('', { iceServers: [] });
const receiver = new ndc.PeerConnection('', { iceServers: [] });
const audioDef = new ndc.Audio('0','SendRecv'); audioDef.addOpusCodec(111);
const videoDef = new ndc.Video('1','SendRecv'); videoDef.addH264Codec(96);
const sAudio = sender.addTrack(audioDef);
const sVideo = sender.addTrack(videoDef);
const rVideo = receiver.addTrack(new ndc.Video('1','RecvOnly'));
const rAudio = receiver.addTrack(new ndc.Audio('0','RecvOnly'));
let recvBytes=0, recvPackets=0;
if (MODE==='drain') {
  rVideo.onMessage(()=>{recvBytes++; });
  rAudio.onMessage(()=>{recvBytes++; });
}
// set up signaling
const sdpS = await sender.createOffer([audioDef, videoDef]);
await receiver.setRemoteDescription(sdpS, [rVideo.getSSRCs() ? rVideo : rVideo, rAudio ? rAudio : audioDef]);
const sdpR = await receiver.createAnswer();
await sender.setRemoteDescription(sdpR);
// wait for ICE to be connected
const t0=Date.now();
while (sender.state()!=='connected' && Date.now()-t0<8000) await sleep(50);
const iceState = sender.state();
log('loopback ice state=', iceState, `took=${Date.now()-t0}ms`);
if (iceState!=='connected') { log('WARN: loopback not connected; continuing in ', iceState); }

// ---- packetizers per WebRtcWrapper ----
const audioSsrc = rAudio.getSSRCs()[0] || sender.getTrackForSSRC ? null : null;
const vSsrcs = sVideo.getSSRCs ? sVideo.getSSRCs() : [1];
const aSsrcs = sAudio.getSSRCs ? sAudio.getSSRCs() : [2];
const vSsrc=vSsrcs[0], aSsrc=aSsrcs[0];
const cfgAudio = new ndc.RtpPacketizationConfig(aSsrc, '', 111, 48000); cfgAudio.playoutDelayId=5;
const cfgVideo = new ndc.RtpPacketizationConfig(vSsrc, '', 96, 90000); cfgVideo.playoutDelayId=5;
const aPz = new ndc.RtpPacketizer(cfgAudio);
const vPz = new ndc.H264RtpPacketizer('StartSequence', cfgVideo);
vPz.addToChain(new ndc.RtcpSrReporter(cfgVideo));
vPz.addToChain(new ndc.RtcpNackResponder());
vPz.addToChain(new ndc.PacingHandler(25*1000*1000, 1));   // 25 MB/s like production
aPz.addToChain(new ndc.RtcpSrReporter(cfgAudio));
aPz.addToChain(new ndc.RtcpNackResponder());
sAudio.setMediaHandler(aPz);
sVideo.setMediaHandler(vPz);
log('packetizers attached; video codec=H264 PacingHandler=25MB/s');

// ---- drive: demux -> TimedTrack -> real send (the production shape) ----
let sentV=0, sentA=0, sentVBytes=0, sendErr=0;
const vm = await import('@dank074/discord-video-stream');
const media = await vm.demux(ff.stdout, { format: 'nut' });
log('demux resolved. video=', !!media.video, 'audio=', !!media.audio);
const video = new TimedTrack((f,ms)=>{ try{ sVideo.sendMessageBinary(f); sentV++; sentVBytes+=f.length; }catch(e){ sendErr++; } }, 'video', {avGateMs:20,maxCatchupMs:250});
const audio = new TimedTrack((f,ms)=>{ try{ sAudio.sendMessageBinary(f); sentA++; }catch(e){ sendErr++; } }, 'audio', {avGateMs:20,maxCatchupMs:250});
video.syncTrack = audio;
media.video.stream.pipe(video);
if (media.audio) media.audio.stream.pipe(audio);
log('pipes attached; run window begins');

const iv=setInterval(()=>{
  log(`vSend=${sentV} aSend=${sentA} vBytesMB=${(sentVBytes/1048576).toFixed(2)} err=${sendErr} recvPkts=${recvPackets} rssMB=${rssMB()} hbMaxGap=${hbGapMax}ms state=${sender.state()}`);
  if (Date.now()-T0 >= SECS*1000) done();
},2000);

function done(){
  try{clearInterval(iv);}catch{}
  try{clearInterval(hb);}catch{}
  log(`FINISH [${MODE}] vSend=${sentV} aSend=${sentA} vBytesMB=${(sentVBytes/1048576).toFixed(2)} err=${sendErr} rssMB=${rssMB()} hbMaxGap=${hbGapMax}ms`);
  log(sentV===0 ? 'VERDICT: zero frames passed send (wedge BEFORE native send)'
    : (hbGapMax>600 ? 'VERDICT: MAIN THREAD BLOCKED in native send (heartbeat starving) -> node-datachannel/PacingHandler'
    : (sendErr>0 ? 'VERDICT: send throwing (Track closed/state)' : 'VERDICT: send path HEALTHY in loopback (drain='+MODE+')'));
  cleanup();
}
function cleanup(){
  try{video.destroy();}catch{}
  try{audio.destroy();}catch{}
  try{ff.kill('SIGKILL');}catch{}
  try{sender.close();}catch{}
  try{receiver.close();}catch{}
  setTimeout(()=>process.exit(0),400).unref();
}
process.on('exit',cleanup);
process.on('SIGINT',cleanup);
process.on('SIGTERM',cleanup);
