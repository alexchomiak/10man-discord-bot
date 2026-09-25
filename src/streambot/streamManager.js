'use strict';

const { M } = require('./messages');
const { TAG, redactToken } = require('./config');
const fs = require('fs');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const { setTimeout: sleep } = require('node:timers/promises');
const { PersistentTrackFeeder } = require('./persistentTrackFeeder');
// NOTE: module reference (not a destructure) so test harnesses can patch the
// exported functions (demuxGuard.ensureTrackerInstalled) and have the manager
// observe the patch.
const demuxGuard = require('./demuxGuard');
const telemetry = require('./telemetry');
const { isYoutubeHlsUrl } = require('./sources');
const { createAlertSink } = require('./alerts');

function log(level, ...parts) {
  if (level === 'error') console.error(TAG, ...parts);
  else console.log(TAG, ...parts);
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

// Counts producer bytes without adding a `data` listener. A data listener can
// switch a readable into flowing mode and race the node-av demuxer, turning
// observability into packet loss.
class MeteredPassThrough extends PassThrough {
  constructor(options) {
    super(options);
    this.bytesWindow = 0;
    this.bytesTotal = 0;
  }

  _transform(chunk, encoding, callback) {
    const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
    this.bytesWindow += size;
    this.bytesTotal += size;
    callback(null, chunk);
  }

  takeByteCounts() {
    const counts = { window: this.bytesWindow, total: this.bytesTotal };
    this.bytesWindow = 0;
    return counts;
  }
}

// fluent-ffmpeg's close-race signature (lib/processor.js:489 emitEnd on the
// output Pipe's 'close'): the DESTINATION pipe closes, and 20ms later fluent
// schedules emitEnd(new Error('Output stream closed')) + kill — REGARDLESS of
// why the pipe closed. That close happens on three distinct paths:
//   * clean VOD media-EOF (ffmpeg done, stdout drained, pipe closes),
//   * a demux failure mid-stream (pipe error/close before ffmpeg exits),
//   * an explicit stop() (we destroy the output ourselves).
// So this exact string is AMBIGUOUS: it is the pipe event, not a completion
// verdict. Callers must treat the promise settle as a settle (not a
// rejection) but must NOT assume clean completion — the child's exit code
// (command.process.exitCode === 0) or the playStream drain is the clean
// signal. Any OTHER 'error' event (real ffmpeg exit failure, output-stream
// error, ECONNRESET, ...) is a genuine fault.
function isAmbiguousPipeClose(err) {
  return Boolean(err && typeof err.message === 'string' && err.message === 'Output stream closed');
}

// Deprecated alias (kept so existing import sites/tests keep working):
// the name no longer reflects the semantics — see isAmbiguousPipeClose.
const isBenignEnd = isAmbiguousPipeClose;

class StreamManager {
  constructor(client, defaultChannelId = null, config = null) {
    this.client = client;
    this.defaultChannelId = defaultChannelId;
    this.config = config || {};
    // Outbound alert sink (see alerts.js): the bot account is restricted and
    // cannot send channel messages, so end-of-stream / error feedback is
    // logged locally and optionally POSTed to TELEMETRY_WEBHOOK_URL.
    // Fire-and-forget; notify() never throws. (config.alertSink — a ready-made
    // sink object with notify(event, detail) — is honored as a test seam.)
    const injected = this.config && typeof (this.config.alertSink || {}).notify === 'function' ? this.config.alertSink : null;
    if (injected) {
      this.alertSink = injected;
    } else {
      try {
        this.alertSink = createAlertSink({ url: (this.config && this.config.alertWebhookUrl) || null });
      } catch {
        this.alertSink = { notify: () => Promise.resolve() };
      }
    }
    this.session = null;
    this._videoModule = null;
    this._vaapiReady = null;
    // A single shared Streamer for the manager's lifetime: `new Streamer()`
    // attaches a permanent client.on('raw') listener, so per-session
    // instances leak listeners on every start(). Cleared only when the
    // streamer's voice state dies (leaveChannel/leaveVoice); a streamer that
    // still has a live voiceConnection is reused — that IS the feature.
    this._streamer = null;
    // Persistent per-channel voice state (null when not in a channel):
    // { guildId, channelId, streamer, webRtc, joinedAt, graceTimer, pipeline }.
    // Kept alive across playback ends (the grace window) so the next stream
    // can skip joinVoice entirely. `streamer.voiceConnection` truthy = the
    // voice WS is live.
    this.voiceLink = null;
    // Test seam for the grace window (node:test has no fake timers).
    this._timerFactory = null;
    this._operations = Promise.resolve();
    this._feederFactory = (streamer, videoModule) => new PersistentTrackFeeder({
      streamer, videoModule, width: this.config.streamWidth || 1920,
      height: this.config.streamHeight || 1080, frameRate: this.config.streamFrameRate || 30
    });
  }

  _getStreamer(videoModule) {
    if (!this._streamer) this._streamer = new videoModule.Streamer(this.client);
    return this._streamer;
  }

  _verbose(...parts) {
    if (this.config.verbose === true) log('info', ...parts);
  }

  async _video() {
    if (this._videoModule) return this._videoModule;
    // discord-video-stream uses debug-level internally for demux/frame timing
    // logs. Override DEBUG_LEVEL here so a host-wide setting cannot make the
    // streambot noisy unless its own VERBOSE switch is enabled.
    process.env.DEBUG_LEVEL = this.config.verbose === true ? 'INFO' : 'OFF';
    this._videoModule = await import('@dank074/discord-video-stream');
    return this._videoModule;
  }

  setupStreamOptions(videoModule, startOffsetSec, durationSec, inputFormat) {
    const cfg = this.config;
    const codec = videoModule.Utils
      ? videoModule.Utils.normalizeVideoCodec(cfg.videoCodec || 'H264')
      : (cfg.videoCodec || 'H264').toUpperCase();
    const bitrate = Number.isFinite(cfg.streamBitrate) ? cfg.streamBitrate : 5000;
    const width = cfg.streamWidth || 1920; // fixed session format; pad instead of changing aspect ratio
    const height = Number.isFinite(cfg.streamHeight) && cfg.streamHeight > 0 ? cfg.streamHeight : 1080;
    if (cfg.verbose) log('info', `stream options: width=${width} (padded, AR-preserving), height=${height}, codec=${codec}`);
    const opts = {
      width,
      height,
      frameRate: cfg.streamFrameRate || 30,
      videoCodec: codec,
      bitrateVideo: bitrate,
      bitrateVideoMax: Math.round(bitrate * 1.4),
      includeAudio: true,
      hardwareAcceleratedDecoding: !!cfg.hardwareDecode,
      encoder: this._encoder(videoModule),
      minimizeLatency: false,
      h26xPreset: 'ultrafast'
    };
    // Input options (rendered by the library as `<options> -i <source>`).
    //   * inputFormat: a `-f <fmt>` input demuxer. The $join FILLER uses the
    //     local libavfilter source; the ONLY spelling ffmpeg's input protocol
    //     accepts is `-f lavfi -i testsrc=...` (the `lavfi://...` URI form is
    //     NOT a registered input protocol and fails with "Protocol not found").
    //   * -ss <sec>: existing seek offset (unchanged behavior).
    //   * -t <sec>: an upper bound — makes the filler SELF-TERMINATE into the
    //     existing "stream ended → grace → leave" flow.
    const inputOpts = [];
    if (inputFormat) inputOpts.push('-f', String(inputFormat));
    const offset = Number.isFinite(startOffsetSec) && startOffsetSec > 0 ? Math.round(startOffsetSec) : 0;
    if (offset > 0) inputOpts.push('-ss', String(offset));
    const dur = Number.isFinite(durationSec) && durationSec > 0 ? Math.round(durationSec) : 0;
    if (dur > 0) inputOpts.push('-t', String(dur));
    if (inputOpts.length > 0) opts.customInputOptions = inputOpts;
    return opts;
  }

  // DASH/merge path: builds a self-spawned fluent-ffmpeg command that reads
  // TWO progressive inputs (best video + best audio) and writes a NUT stream
  // into a PassThrough, mirroring the library's own prepareStream output
  // configuration (see @dank074/discord-video-stream/dist/media/newApi.js:82-241).
  // Returns a shape compatible with the single path's result:
  //   { command, output, promise, controller }
  // so the rest of start() can treat both identically.
  // `controller` is a realtime-volume object identical to what the library
  // exposes (azmq + zeromq). If the zeromq loopback roundtrip can't be
  // established on this host, the controller is still returned but returns
  // false from setVolume (volume stays at 1.0) — parity with the library's
  // own behavior when azmq can't connect.
  async preparePlayback(videoModule) {
    try {
      await demuxGuard.ensureTrackerInstalled();
    } catch (e) {
      this._verbose(`demux tracker unavailable: ${e && e.message}`);
    }
    if (this.config.videoEncoder === 'vaapi') await this._ensureVaapiReady();
    return videoModule;
  }

  _vaapiCandidates() {
    const configured = this.config.vaapiDevice || '/dev/dri/renderD128';
    let discovered = [];
    try {
      discovered = fs.readdirSync('/dev/dri')
        .filter(name => /^renderD\d+$/.test(name))
        .sort()
        .map(name => `/dev/dri/${name}`);
    } catch { /* preflight reports the configured path below */ }
    return [...new Set([configured, ...discovered])];
  }

  _probeVaapiDevice(device) {
    const bin = this.config.ffmpegPath || 'ffmpeg';
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-vaapi_device', device,
      '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30',
      '-frames:v', '1', '-vf', 'format=nv12,hwupload',
      '-c:v', 'h264_vaapi', '-profile:v', 'constrained_baseline',
      '-f', 'null', '-'
    ];
    return new Promise(resolve => {
      let child;
      try { child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
      catch (error) { resolve({ ok: false, detail: error.message }); return; }
      let stderr = '';
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      child.stderr.on('data', chunk => {
        stderr = (stderr + String(chunk)).slice(-4096);
      });
      child.once('error', error => finish({ ok: false, detail: error.message }));
      child.once('close', code => finish({ ok: code === 0, detail: stderr.trim() || `ffmpeg exited ${code}` }));
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        finish({ ok: false, detail: 'VAAPI probe timed out after 10 seconds' });
      }, 10000);
    });
  }

  _probeVaapiInfo(device) {
    return new Promise(resolve => {
      let child;
      try {
        child = spawn('vainfo', ['--display', 'drm', '--device', device], {
          env: { ...process.env, LIBVA_DRIVER_NAME: process.env.LIBVA_DRIVER_NAME || 'iHD' },
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        resolve(`vainfo could not start: ${error.message}`);
        return;
      }
      let output = '';
      let settled = false;
      const finish = detail => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(String(detail || '').replace(/\s+/g, ' ').trim());
      };
      const collect = chunk => { output = (output + String(chunk)).slice(-4096); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.once('error', error => finish(`vainfo failed to start: ${error.message}`));
      child.once('close', code => finish(`vainfo exit ${code}: ${output}`));
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        finish('vainfo timed out after 10 seconds');
      }, 10000);
    });
  }

  async _ensureVaapiReady() {
    if (this._vaapiReady) return this._vaapiReady;
    this._vaapiReady = (async () => {
      const failures = [];
      for (const device of this._vaapiCandidates()) {
        const result = await this._probeVaapiDevice(device);
        if (result.ok) {
          this.config.vaapiDevice = device;
          log('info', `VAAPI ready: h264_vaapi on ${device}`);
          return device;
        }
        failures.push(`${device}: ${String(result.detail || 'initialization failed').replace(/\s+/g, ' ').trim()}`);
      }
      if (failures.length) {
        failures.push(`diagnostic: ${await this._probeVaapiInfo(this._vaapiCandidates()[0])}`);
      }
      this._vaapiReady = null;
      throw new Error(`VAAPI H.264 initialization failed for every render device. ${failures.join(' | ')}`);
    })();
    return this._vaapiReady;
  }

  _encoder(videoModule, inputOnVaapi = false) {
    const cfg = this.config;
    const keyframeFrames = Math.max(1, Math.round(
      (cfg.streamFrameRate || 30) * (cfg.keyframeIntervalSec || 2)
    ));
    if (cfg.videoEncoder === 'vaapi') {
      const device = cfg.vaapiDevice || '/dev/dri/renderD128';
      // The library's generic VAAPI preset leaves profile, GOP and IDR
      // behavior to the driver. Arc can consequently emit a valid H.264
      // stream that late-joining Discord viewers cannot initialize. Keep the
      // hardware upload path, but constrain H.264 to a WebRTC-safe stream
      // with decoder headers on every one-second IDR boundary.
      return (bitrate, bitrateMax) => ({
        H264: {
          name: 'h264_vaapi',
          // Hardware-decoded frames already live on the VAAPI device. Avoid
          // downloading and uploading them between decode, scale and encode.
          outFilters: inputOnVaapi ? [] : ['format=nv12', 'hwupload'],
          globalOptions: ['-vaapi_device', device],
          options: [
            '-profile:v', 'constrained_baseline',
            '-level:v', '4.1',
            '-g', String(keyframeFrames),
            '-keyint_min', String(keyframeFrames),
            '-idr_interval', '0',
            '-bf', '0',
            '-b:v', `${Math.round(bitrate)}k`,
            '-maxrate:v', `${Math.round(bitrateMax)}k`
          ]
        }
      });
    }
    return videoModule.Encoders?.software?.({ x264: { preset: 'superfast', tune: 'film' } }) || null;
  }

  _buildDashMerge(videoModule, videoUrl, audioUrl, startOffsetSec, singleOptions = null, piece = null) {
    const cfg = this.config;
    const ff = require('fluent-ffmpeg');

    const codec = videoModule.Utils
      ? videoModule.Utils.normalizeVideoCodec(cfg.videoCodec || 'H264')
      : (cfg.videoCodec || 'H264').toUpperCase();
    const bitrate = Number.isFinite(cfg.streamBitrate) && cfg.streamBitrate > 0 ? Math.round(cfg.streamBitrate) : 5000;
    const bitrateMax = Math.round(bitrate * 1.4);
    // A small VBV reservoir smooths the encoded wire rate. With the previous
    // two-second reservoir, complex 1080p IDRs reached ~300 KiB and were
    // fragmented into roughly 200 RTP packets at once. A 300ms reservoir
    // kept the same sample below 100 KiB without reducing average bitrate.
    const vbvBufferKbps = Number.isFinite(cfg.streamVbvBufferKbps) && cfg.streamVbvBufferKbps > 0
      ? Math.round(cfg.streamVbvBufferKbps)
      : Math.max(500, Math.round(bitrate * 0.3));
    const keyframeIntervalSec = Number.isFinite(cfg.keyframeIntervalSec) && cfg.keyframeIntervalSec > 0
      ? cfg.keyframeIntervalSec
      : 2;
    const height = Number.isFinite(cfg.streamHeight) && cfg.streamHeight > 0 ? Math.round(cfg.streamHeight) : 1080;
    const fps = Number.isFinite(cfg.streamFrameRate) && cfg.streamFrameRate > 0 ? Math.round(cfg.streamFrameRate) : 30;
    const audioKbps = Number.isFinite(cfg.streamAudioBitrate) && cfg.streamAudioBitrate > 0 ? Math.round(cfg.streamAudioBitrate) : 128;

    const producerBufferBytes = Math.max(1, Math.round((cfg.pipelineBufferMb || 8) * 1024 * 1024));
    const output = new MeteredPassThrough({ highWaterMark: producerBufferBytes });
    const offset = Number.isFinite(startOffsetSec) && startOffsetSec > 0 ? Math.round(startOffsetSec) : 0;
    const useVaapiFrames = cfg.videoEncoder === 'vaapi' && cfg.hardwareDecode === true && piece?.inputFormat !== 'lavfi';

    const configureInput = (command, url, { localRealtime = false } = {}) => {
      if (localRealtime) {
        // Infinite lavfi sources have no clock of their own.
        command.inputOptions(['-re']);
        return;
      }
      if (!isHttpUrl(url)) return;
      if (isYoutubeHlsUrl(url)) {
        // YouTube's AAC segments use extensionless URLs. FFmpeg 7.1 otherwise
        // rejects the valid AAC stream because its format and URL don't match.
        command.inputOptions(['-extension_picky', '0']);
      }
      const timeoutUs = Math.max(1000, Math.round((cfg.ffmpegReadTimeoutMs || 15000) * 1000));
      command.inputOptions([
        // TimedTrack clocks outgoing Discord packets. A VOD input must also
        // stay near realtime: otherwise FFmpeg can decode separate YouTube
        // video/audio inputs far ahead while the sender applies backpressure,
        // retaining gigabytes of frames before the 8 MiB output pipe.
        '-thread_queue_size', piece?.isLive ? '2048' : '256',
        '-rw_timeout', String(timeoutUs),
        '-user_agent', 'Mozilla/5.0'
      ]);
      if (!piece?.isLive) {
        const burstSec = Math.max(4, Math.ceil(Number(cfg.jitterBufferSec) || 4));
        // Leave headroom to refill after transient network/encoder stalls.
        // The bounded input queue and output pipe prevent unlimited prefetch.
        command.inputOptions(['-readrate', '1.15', '-readrate_initial_burst', String(burstSec)]);
      }
      if (!/m3u8?/i.test(url)) {
        // VOD must finish at clean EOF. Live HTTP proxies can rotate or close
        // an otherwise healthy response at EOF, so reconnect those pieces in
        // place without recreating the persistent Discord Go Live session.
        const reconnect = ['-reconnect', '1', '-reconnect_streamed', '1'];
        if (piece?.isLive) reconnect.push('-reconnect_at_eof', '1');
        reconnect.push('-reconnect_delay_max', '5');
        command.inputOptions(reconnect);
      }
    };

    // Primary input (video) with its own -ss when an offset is set.
    const command = ff(videoUrl);
    if (singleOptions?.customInputOptions?.length) command.inputOptions(singleOptions.customInputOptions);
    else if (offset > 0) command.inputOptions(['-ss', String(offset)]);
    if (useVaapiFrames) {
      const device = cfg.vaapiDevice || '/dev/dri/renderD128';
      command.inputOptions([
        '-hwaccel', 'vaapi',
        '-hwaccel_device', device,
        '-hwaccel_output_format', 'vaapi'
      ]);
    }
    configureInput(command, videoUrl, { localRealtime: piece?.inputFormat === 'lavfi' });
    // A second input is needed for split DASH audio and for the synthetic
    // video-only filler. Do not attach a realtime anullsrc to ordinary
    // combined A/V media: FFmpeg can decode that VOD far ahead of the paced
    // synthetic track and retain every encoded video packet in its muxer,
    // growing native RSS without bound (observed at >17 GiB in 26 seconds).
    const needsSilentAudio = !audioUrl && piece?.inputFormat === 'lavfi';
    if (audioUrl || needsSilentAudio) {
      command.input(audioUrl || 'anullsrc=channel_layout=stereo:sample_rate=48000');
      if (needsSilentAudio) command.inputOptions(['-f', 'lavfi']);
      if (audioUrl && offset > 0) command.inputOptions(['-ss', String(offset)]);
      configureInput(command, audioUrl, { localRealtime: needsSilentAudio });
    }

    // fluent-ffmpeg's old `ffmpeg -formats` parser does not understand the
    // extra device flag in modern output (`D d lavfi ...`). It consequently
    // rejects a valid lavfi input during its preflight. Teach this command's
    // capability view about lavfi while preserving every other codec/format
    // check. No dependency patching or global monkey-patch is needed.
    if ((!audioUrl || piece?.inputFormat === 'lavfi') && typeof command.availableFormats === 'function') {
      const availableFormats = command.availableFormats.bind(command);
      command.availableFormats = (callback) => availableFormats((error, formats) => {
        if (!error && formats && !formats.lavfi) {
          formats.lavfi = { description: 'Libavfilter virtual input device', canDemux: true, canMux: false };
        }
        callback(error, formats);
      });
    }

    // Output config mirrors newApi.js:111-145 (single-input case) adapted to
    // the 2-input map (0:v:0 from video, 1:a:0? from audio, tolerant of a
    // missing audio stream on odd formats).
    const deinterlaceFilter = piece?.isLive
      ? (useVaapiFrames
          ? 'deinterlace_vaapi=mode=motion_adaptive:rate=frame:auto=1,'
          : 'bwdif=mode=send_frame:parity=auto:deint=interlaced,')
      : '';
    const videoFilter = useVaapiFrames
      ? `${deinterlaceFilter}scale_vaapi=w=${cfg.streamWidth || 1920}:h=${height}:force_original_aspect_ratio=decrease:force_divisible_by=2:format=nv12,` +
        `pad_vaapi=w=${cfg.streamWidth || 1920}:h=${height}:x=(ow-iw)/2:y=(oh-ih)/2`
      : `${deinterlaceFilter}scale=${cfg.streamWidth || 1920}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,` +
        `pad=${cfg.streamWidth || 1920}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
    command
      .output(output)
      .outputFormat('nut')
      .addOutputOption('-map 0:v:0')
      .addOutputOption((audioUrl || needsSilentAudio) ? '-map 1:a:0' : '-map 0:a:0?')
      .videoFilter(videoFilter)
      .fpsOutput(fps)
      .addOutputOption([
        '-fps_mode', 'cfr', '-b:v', `${bitrate}k`, '-maxrate:v', `${bitrateMax}k`,
        '-bufsize:v', `${vbvBufferKbps}k`, '-bf', '0',
        // h264_vaapi accepts VAAPI hardware frames. Requesting the software
        // yuv420p output format conflicts with the hwupload/VAAPI filter path.
        ...(cfg.videoEncoder === 'vaapi' ? [] : ['-pix_fmt', 'yuv420p'])
      ]);

    // Finite VOD tracks must drain to their own EOF. FFmpeg 7.1's -shortest
    // synchronization can stall split paced inputs while FFmpeg memory grows
    // upstream of this output pipe. Pair padding/shortest only on the
    // existing live/filler path; endless apad would otherwise prevent VOD EOF.
    const padAudio = !!(piece?.isLive || piece?.isFiller || piece?.inputFormat === 'lavfi');
    if (padAudio) command.addOutputOption('-shortest');
    command.addOutputOption('-force_key_frames', `expr:gte(t,n_forced*${keyframeIntervalSec})`);

    // Encoder settings use VAAPI on Intel when configured and libx264
    // otherwise. Fall back to ultrafast libx264 if the library exports no
    // encoder helper (mainly useful for compatibility with older releases).
    let encoderSettings = null;
    try {
      const encoder = this._encoder(videoModule, useVaapiFrames);
      if (encoder) {
        if (typeof encoder === 'function') {
          const byCodec = encoder(bitrate, bitrateMax) || {};
          encoderSettings = byCodec[codec] || byCodec.H264 || null;
        }
      }
    } catch { /* fall through to fallback */ }
    if (encoderSettings) {
      command
        .videoCodec(encoderSettings.name)
        .videoFilter(encoderSettings.outFilters ?? [])
        .outputOptions(encoderSettings.options)
        .outputOptions(encoderSettings.globalOptions ?? []);
    } else {
      command
        .videoCodec('libx264')
        .outputOptions('-preset', 'ultrafast')
        .outputOptions('-pix_fmt', 'yuv420p')
        .outputOptions('-bf', '0');
      if (cfg.verbose) log('info', 'media pipeline: libx264/ultrafast fallback used (Encoders module unavailable)');
    }

    if (cfg.verbose) {
      log('info', `media pipeline: input=${piece?.isLive ? 'live' : (piece?.isFiller ? 'filler' : 'vod')} ` +
        `output=${cfg.streamWidth || 1920}x${height}@${fps} encoder=${encoderSettings?.name || 'libx264'} ` +
        `rate=${bitrate}k/${bitrateMax}k vbv=${vbvBufferKbps}k gop=${keyframeIntervalSec}s ` +
        `buffer=${cfg.pipelineBufferMb || 8}MiB`);
    }

    // Audio: libopus 48k stereo @streamAudioBitrate k (mirrors newApi.js:147-161).
    command
      .audioChannels(2)
      .audioFrequency(48000)
      .audioCodec('libopus')
      .audioBitrate(`${audioKbps}k`)
      .addOutputOption('-lfe_mix_level', '1');

    // Audio filters: start at 1.0 volume (matches the library's
    // volume@internal_lib=1.0 baseline) and hang the azmq broker endpoint off
    // it so realtime setVolume() can drive the level without a restart.
    //
    // Pre-flight: try to bind the chosen endpoint with a zeromq Reply socket
    // (the broker's role, which ffmpeg's azmq filter takes over at runtime).
    // Only if that bind succeeds do we attach the azmq filter — if the host
    // can't bind the random 127.x IP (e.g. macOS quirks), the azmq filter
    // will fail ffmpeg the moment it initialises and the whole stream breaks.
    // Pre-check keeps the stream alive; volume control is just unavailable.
    const r = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo;
    const candidateEndpoints = [
      `tcp://127.${r(0, 255)}.${r(0, 255)}.${r(2, 254)}:42069`,
      `tcp://127.0.0.1:42069`
    ];
    const tryBind = (zmq, endpoint) => {
      try {
        const s = new zmq.Reply();
        s.bindSync(endpoint);
        s.closeSync();
        return true;
      } catch { return false; }
    };
    let bindableEndpoint = null;
    let zmqNamespace = null;
    try {
      const dyn = require('zeromq');
      zmqNamespace = dyn;
      for (const ep of candidateEndpoints) {
        if (tryBind(dyn, ep)) { bindableEndpoint = ep; break; }
      }
    } catch { /* zeromq not loadable — volume control will be off */ }

    command.audioFilters(`volume@internal_lib=1.0${padAudio ? ',apad' : ''}`);
    if (bindableEndpoint) {
      command.audioFilters(`azmq=b=${bindableEndpoint.replaceAll(':', '\\\\:')}`);
    } else {
      this._verbose('dash merge: azmq filter skipped (no bindable loopback endpoint); volume fixed at 1.0');
    }

    // Wire the zeromq request client. Lazy require — keeps the file from
    // hard-failing if the dep isn't there.
    let zmqClientPromise = null;
    if (bindableEndpoint && zmqNamespace) {
      try {
        zmqClientPromise = new Promise((resolve) => {
          const client = new zmqNamespace.Request({ sendTimeout: 5000, receiveTimeout: 5000 });
          client.connect(bindableEndpoint);
          resolve(client);
        });
      } catch (e) {
        this._verbose(`dash merge: volume control disabled (zeromq failed: ${e && e.message})`);
      }
    }

    // Promise resolves on ffmpeg end, rejects on error. Mirrors newApi.js:168-185,
    // except the ambiguous fluent-ffmpeg close-race string (see
    // isAmbiguousPipeClose) is resolved rather than rejected — the pipe-close
    // event can be clean EOF, a demux failure, or a stop, and none of those
    // should crash the awaiter as an unhandled rejection.
    const promise = new Promise((resolve, reject) => {
      command.on('error', (err) => {
        if (isAmbiguousPipeClose(err)) {
          resolve();
          return;
        }
        reject(err);
      });
      command.on('end', () => resolve());
    });
    promise.catch(() => { /* caller owns error reporting */ });
    const closeVolume = () => { void zmqClientPromise?.then(client => client.close()).catch(() => {}); };
    promise.then(closeVolume, closeVolume);

    command.run();

    const controller = {
      _volume: 1.0,
      get volume() { return this._volume; },
      async setVolume(newVolume) {
        if (typeof newVolume !== 'number' || Number.isNaN(newVolume) || newVolume < 0) return false;
        if (!zmqClientPromise) return false;
        try {
          const client = await zmqClientPromise;
          if (!client) return false;
          await client.send(`volume@internal_lib volume ${newVolume}`);
          const [res] = await client.receive();
          if (res.toString('utf-8').split(' ')[0] !== '0') return false;
          this._volume = newVolume;
          return true;
        } catch (e) {
          this._verbose(`setVolume(${newVolume}) failed: ${e && e.message}`);
          return false;
        }
      }
    };

    return { command, output, promise, controller, waitForExit: () => promise.catch(() => {}) };
  }

  _sanitize(text) {
    return redactToken(String(text || ''), this.client?.token);
  }

  // Genuine-error feedback: in addition to the existing log('error', …) line,
  // forward a sanitized (token-redacted) one-liner to the alert webhook.
  // Fire-and-forget — the sink must never throw or block the caller.
  _notifyError(detail) {
    const sanitized = this._sanitize(detail);
    try {
      void this.alertSink.notify('stream-error', sanitized).catch(() => {});
    } catch { /* the sink never throws (alerts.js guarantees this) */ }
  }

  _validInput(value) {
    const s = String(value || '').trim();
    if (!s) return false;
    if (/^https?:\/\//i.test(s)) return true;
    try {
      return fs.statSync(s).isFile();
    } catch {
      return false;
    }
  }

  // Burst seconds (readrateInitialBurst) for playStream, or 0 to disable.
  // The library sets both streams to noSleep while this is active, so buffered
  // frames are sent as fast as possible instead of at 30 fps. The production
  // default is zero; nonzero values are retained only as an explicit tuning
  // knob for short startup experiments.
  _startBurstSec() {
    const cfg = this.config;
    if (cfg) {
      const av = Number(cfg.avSyncBurstSec);
      if (Number.isFinite(av) && av >= 0) return Math.round(av);
      const sb = Number(cfg.startBurstSec);
      if (Number.isFinite(sb) && sb >= 0) return Math.round(sb);
    }
    return 0;
  }

  // Serialized (FIFO) operation queue. Safety argument: `this._operations`
  // is ALWAYS a settled promise — every task's result (resolve OR reject) is
  // chained into `.catch(() => {})` before any later task attaches, so no
  // task can strand the lock with a rejection, and the queue itself can never
  // be left pending. The ONLY way the queue could stay wedged is a task
  // promise that never settles (a hung await). That class is now eliminated
  // at the source: every gateway-dependent await on the join path
  // (joinVoice, _leaveVoiceLink) is bounded by _raceWithTimeout inside
  // _ensureVoiceLink, so every start()/ensureChannel() path settles. Any
  // unbounded await added to a serialized task MUST get a timeout, or the
  // serialize lock wedges and every later $stream queues behind it forever.
  _serialize(fn) {
    const operation = this._operations.then(fn);
    this._operations = operation.catch(() => {});
    return operation;
  }

  _voiceJoinTimeoutMs() {
    const ms = Number(this.config.joinVoiceTimeoutMs);
    return Number.isFinite(ms) && ms > 0 ? ms : 20000;
  }

  // Promise.race against a timeout that REJECTS. Both reactions are attached
  // synchronously (same microtask as the call), so a promise that hangs past
  // the timeout can never later produce an unhandledRejection, and the timer
  // is cleared on either settle so no timers leak.
  _raceWithTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
      // NOTE: this timeout is the SOLE thing that may keep the event loop
      // alive (e.g. a hung gateway await with no other work pending), so it
      // must NOT be unref'd — unref'd timers can let the process exit before
      // the timeout ever fires. It is always cleared on either settle.
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new Error(message)), ms);
      Promise.resolve(promise).then(
        value => finish(resolve, value),
        error => finish(reject, error)
      );
    });
  }

  getVoiceLink(guildId, channelId) {
    const link = this.voiceLink;
    return link?.guildId === guildId && link.channelId === channelId ? link : null;
  }

  _clearGraceTimer(link) {
    if (!link?.graceTimer) return;
    if (typeof link.graceTimer.clear === 'function') link.graceTimer.clear();
    else clearTimeout(link.graceTimer);
    link.graceTimer = null;
  }

  _graceMs() {
    const ms = Number(this.config.streamGraceMs);
    return Number.isFinite(ms) && ms > 0 ? ms : 300000;
  }

  _cleanupTimeoutMs() {
    const ms = Number(this.config.streamCleanupTimeoutMs);
    return Number.isFinite(ms) && ms > 0 ? ms : 5000;
  }

  _startGraceTimer(link, reason) {
    this._clearGraceTimer(link);
    const fire = () => this._serialize(async () => {
      if (this.voiceLink !== link || link.pipeline?.activeWriter || link.pipeline?.enqueue.length) return;
      try { void this.alertSink.notify('grace-left', M.STREAM_GRACE_LEFT).catch(() => {}); } catch {}
      await this._leaveVoiceLink(link);
    });
    const timer = this._timerFactory ? this._timerFactory(this._graceMs()) : setTimeout(fire, this._graceMs());
    if (this._timerFactory) timer?.then(fire);
    timer?.unref?.();
    link.graceTimer = timer;
    log('info', `content ended (${reason}); persistent stream held for ${this._graceMs()}ms`);
  }

  async _ensureVoiceLink(guildId, channelId, videoModule) {
    const joinTimeoutMs = this._voiceJoinTimeoutMs();
    const existing = this.getVoiceLink(guildId, channelId);
    if (existing?.streamer.voiceConnection && !existing.closing) {
      this._verbose(`voice: join enter guild=${guildId} channel=${channelId} reused=true`);
      this._clearGraceTimer(existing);
      return { ok: true, voiceLink: existing, reused: true };
    }
    if (this.voiceLink) {
      this._verbose(`voice: join enter guild=${guildId} channel=${channelId} reused=false leaving prior link`);
      const prior = this.voiceLink;
      try {
        // joinVoice/_leaveVoiceLink can hang waiting on gateway voice
        // events; bound both so a stuck teardown cannot wedge _serialize.
        await this._raceWithTimeout(
          this._leaveVoiceLink(prior),
          joinTimeoutMs,
          `leaveVoiceLink timed out after ${joinTimeoutMs}ms`
        );
      } catch (error) {
        // Forced bookkeeping reset: mark the old link closing so it is
        // neither reused nor re-torn-down, and drop it from state so the
        // failed close cannot wedge the join. The stray close keeps running
        // in the background harmlessly (idempotent on the real streamer).
        log('error', `voice: ${error.message} — force-resetting stale voiceLink bookkeeping to continue join`);
        prior.closing = prior.closing || Promise.resolve();
        if (this.voiceLink === prior) this.voiceLink = null;
      }
      this._verbose('voice: prior link left (or force-reset)');
    } else {
      this._verbose(`voice: join enter guild=${guildId} channel=${channelId} reused=false no prior link`);
    }
    const streamer = this._getStreamer(videoModule);
    // FORCE-CLEAR a stale server-side voice session before the fresh join.
    // A prior container instance that died mid-voice leaves Discord believing
    // this selfbot user is still in a voice channel; in that state the
    // re-sent JOIN voice-state is a server no-op, so VOICE_STATE_UPDATE /
    // VOICE_SERVER_UPDATE never arrive and joinVoice hangs. Streamer.leaveVoice()
    // (Streamer.js:134-140 -> signalLeaveVoice:178-186, no truthiness guard)
    // broadcasts a null-channel VOICE_STATE_UPDATE (gateway op 4) UNCONDITIONALLY
    // — even when this process has no voiceConnection — so it clears the stale
    // server state. It is a gateway opcode via client.ws.broadcast, not a chat
    // REST call, so it is permitted for this restricted selfbot. Idempotent.
    try {
      streamer.leaveVoice();
      this._verbose(`voice: sent null-channel voice-state clear before fresh join guild=${guildId} channel=${channelId}`);
    } catch (clearError) {
      log('warn', `voice: pre-join clear send failed (continuing): ${clearError && clearError.message}`);
    }
    // NOTE: no sleep between the clear and joinVoice — both voice-state ops
    // travel the SAME ordered gateway WebSocket (client.ws.broadcast), so the
    // null-channel clear is always processed by Discord before the join's
    // real-channel op. Ordering, not wall-clock, guarantees the join is seen
    // as a fresh (null→channel) membership transition rather than a redundant
    // channel→channel no-op. A sleep would only add latency to the join path.
    try {
      this._verbose(`voice: joinVoice start guild=${guildId} channel=${channelId}`);
      const webRtc = await this._raceWithTimeout(
        streamer.joinVoice(guildId, channelId),
        joinTimeoutMs,
        `joinVoice timed out after ${joinTimeoutMs}ms (no VOICE_STATE_UPDATE/VOICE_SERVER_UPDATE — restricted selfbot voice gateway or stale server-side session)`
      );
      this._verbose(`voice: joinVoice resolved guild=${guildId} channel=${channelId}`);
      const link = { guildId, channelId, streamer, webRtc, joinedAt: Date.now(), graceTimer: null, pipeline: null };
      this.voiceLink = link;
      return { ok: true, voiceLink: link, reused: false };
    } catch (error) {
      const isTimeout = /timed out after/.test(String((error && error.message) || ''));
      log('error', `voice: joinVoice failed: ${error.message}`);
      try { streamer.leaveVoice(); } catch {}
      this._notifyError(`joinVoice failed: ${error.message}`);
      return { ok: false, message: isTimeout ? M.STREAM_JOIN_TIMEOUT : this._sanitize(error.message || M.STREAM_JOIN_FAILED) };
    }
  }

  _ensurePipeline(link, videoModule) {
    if (link.pipeline) return link.pipeline;
    const control = new AbortController();
    const feeder = this._feederFactory(link.streamer, videoModule);
    const pipeline = {
      streamer: link.streamer, webRtc: null, feeder, control,
      enqueue: [], activeWriter: null,
      writerTask: null, closed: false, playPromise: null, watchdog: null
    };
    link.pipeline = pipeline;
    let resolveReady;
    pipeline.ready = new Promise(resolve => { resolveReady = resolve; });
    pipeline.resolveReady = resolveReady;
    // Create one Discord Go Live/WebRTC connection for the entire voice link.
    // Individual FFmpeg producers are attached beneath it by the feeder.
    const startTimeoutMs = this.config.playStreamStartTimeoutMs || 30000;
    pipeline.playPromise = this._raceWithTimeout(
      Promise.resolve().then(() => {
        if (pipeline.closed) throw new Error('Persistent pipeline closed during startup');
        return feeder.start();
      }),
      startTimeoutMs,
      M.STREAM_PLAY_STREAM_HANG
    ).then(connection => {
      if (!pipeline.closed) {
        // createStream() resolves with the exact connected WebRTC wrapper.
        // Treat that as authoritative instead of polling the library's
        // mutable voiceConnection.streamConnection reference.
        pipeline.webRtc = connection;
        pipeline.resolveReady(true);
      }
      return connection;
    });
    const fail = error => {
      if (pipeline.closed) return;
      this._notifyError(`persistent playStream failed: ${error.message}`);
      pipeline.resolveReady(false);
      void this._serialize(() => this._leaveVoiceLink(link));
    };
    pipeline.playPromise.catch(fail);
    return pipeline;
  }

  _prepareSingle(videoModule, piece) {
    const options = this.setupStreamOptions(videoModule, piece.startOffsetSec, piece.durationSec, piece.inputFormat);
    return this._buildDashMerge(videoModule, piece.streamUrl, null, piece.startOffsetSec, options, piece);
  }

  _cancelPiece(piece) {
    if (!piece || piece.control.signal.aborted) return;
    piece.control.abort();
    try { piece.command?.kill('SIGTERM'); } catch {}
    piece.output?.destroy?.();
  }

  _jitterBufferSec(piece) {
    if (!piece || piece.isFiller || piece.inputFormat === 'lavfi') return 0;
    const seconds = Number(this.config.jitterBufferSec);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : 4;
  }

  // FFmpeg's output PassThrough used to be described as an 8 MiB stall
  // buffer, but attaching the demuxer immediately kept readableLength near
  // zero. Build a real media runway before the timestamp-paced Discord tracks
  // begin draining it. Count only intervals in which producer bytes advance,
  // so a CDN/VPN stall during startup does not consume the requested runway.
  // The capacity threshold and deadline keep very high- and very low-bitrate
  // inputs bounded.
  async _prebuffer(output, piece) {
    const seconds = this._jitterBufferSec(piece);
    if (seconds <= 0 || !output || typeof output.readableLength !== 'number' || output.destroyed || output.readableEnded) return;
    const signal = piece.control?.signal;
    signal?.throwIfAborted?.();
    const capacity = Number(output.readableHighWaterMark) ||
      Math.max(1, Math.round((this.config.pipelineBufferMb || 8) * 1024 * 1024));
    const capacityTarget = Math.max(1, Math.floor(capacity * 0.75));
    const targetActiveMs = seconds * 1000;
    const deadlineMs = Math.max(15000, targetActiveMs * 4);
    const started = Date.now();
    let previousAt = started;
    let previousBytes = Number(output.readableLength) || 0;
    let activeMs = 0;

    await new Promise((resolve, reject) => {
      let interval;
      let done = false;
      const cleanup = () => {
        if (interval) clearInterval(interval);
        output.off?.('end', finish);
        output.off?.('finish', finish);
        output.off?.('close', finish);
        output.off?.('error', fail);
        signal?.removeEventListener?.('abort', abort);
      };
      const settle = (fn, value) => {
        if (done) return;
        done = true;
        cleanup();
        fn(value);
      };
      const finish = () => settle(resolve);
      const fail = error => settle(reject, error);
      const abort = () => settle(reject, signal.reason || new Error('Playback cancelled while buffering'));
      const sample = () => {
        if (signal?.aborted) { abort(); return; }
        if (output.destroyed || output.readableEnded) { finish(); return; }
        const now = Date.now();
        const bytes = Number(output.readableLength) || 0;
        if (bytes > previousBytes) activeMs += now - previousAt;
        previousBytes = bytes;
        previousAt = now;
        if (activeMs >= targetActiveMs || bytes >= capacityTarget || now - started >= deadlineMs) finish();
      };
      output.once?.('end', finish);
      output.once?.('finish', finish);
      output.once?.('close', finish);
      output.once?.('error', fail);
      signal?.addEventListener?.('abort', abort, { once: true });
      interval = setInterval(sample, 100);
      sample();
    });
    this._verbose(`media prebuffer ready: ${(Number(output.readableLength) / 1024 / 1024).toFixed(2)}MiB, target=${seconds}s`);
  }

  async _reapPiece(piece) {
    const escalation = setTimeout(() => { try { piece.command?.kill('SIGKILL'); } catch {} }, 2000);
    try {
      // Fluent-ffmpeg can still be preparing/spawning when stop arrives.
      // Its start listener sees the abort; waitForExit covers that race too.
      await piece.waitForExit?.();
      const child = piece.command?.ffmpegProc;
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise(resolve => child.once('close', resolve));
      }
    } finally {
      clearTimeout(escalation);
      piece.telemetry?.stop();
      piece.output?.destroy?.();
    }
  }

  _pump(link, videoModule) {
    const p = link.pipeline;
    if (p.closed || p.writerTask) return;
    p.writerTask = (async () => {
      // !link.paused: while a pause is held, do NOT shift the next queued
      // piece — the loop exits and the .finally below holds (no advance, no
      // grace). $resume clears the flag, re-enqueues the held session, pumps.
      while (!p.closed && !link.paused && p.enqueue.length) {
        const piece = p.enqueue.shift();
        // Queue time is not playback time. This also makes recovery after an
        // external channel move resume from the position viewers last saw.
        piece.startedAt = Date.now();
        p.activeWriter = piece;
        this.session = piece; // compatibility: status/volume target active content
        let appendTask;
        let clean = false;
        let recoverLive = false;
        let recoverVod = false;
        let vodRecoveryReason = null;
        let liveError = null;
        let stallWatchdog = null;
        let lastVideoFrameAt = 0;
        try {
          if (piece.recoveryAttempt) {
            await sleep(piece.retryDelayMs, undefined, { signal: piece.control.signal });
            if (piece.sourceInput) {
              const resolved = await require('./sources').resolveSource(piece.sourceInput, this.config);
              piece.control.signal.throwIfAborted();
              if (!resolved?.available || resolved.isLive !== piece.isLive) {
                throw new Error(resolved?.note || 'Source unavailable during recovery');
              }
              piece.streamUrl = resolved.streamUrl || null;
              piece.videoUrl = resolved.videoUrl || null;
              piece.audioUrl = resolved.audioUrl || null;
              piece.isDash = !!(piece.videoUrl && piece.audioUrl);
            }
          }
          const result = piece.isDash
            ? this._buildDashMerge(videoModule, piece.videoUrl, piece.audioUrl, piece.startOffsetSec,
              this.setupStreamOptions(videoModule, piece.startOffsetSec), piece)
            : this._prepareSingle(videoModule, piece);
          if (!result?.output || !result.command) throw new Error(M.STREAM_START_FAILED);
          Object.assign(piece, { command: result.command, output: result.output, promise: result.promise,
            volume: result.controller, waitForExit: result.waitForExit });
          result.command.on('start', () => {
            if (piece.control.signal.aborted) { try { result.command.kill('SIGTERM'); } catch {} }
          });
          let finish;
          let reject;
          const completion = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
          const failure = error => {
            if (piece.control.signal.aborted) { finish(); return; }
            if (isAmbiguousPipeClose(error)) {
              const code = result.command.ffmpegProc?.exitCode ?? result.command.process?.exitCode;
              clean = code === 0;
              log('info', `stream ended: pipe closed; ffmpegExit=${code ?? 'unknown'}`);
              piece.ambiguous = true;
              finish();
            } else reject(error);
            result.output.destroy?.();
          };
          result.command.on('end', () => { clean = true; finish(); });
          result.command.on('error', failure);
          result.output.on('error', failure);
          piece.control.signal.addEventListener('abort', () => finish(), { once: true });
          result.promise?.then(() => finish(), failure);
          if (this.config.verbose === true) try {
            piece.telemetry = telemetry.createTelemetry({ command: result.command,
              getOutputBytes: () => result.output?.takeByteCounts?.(),
              getRtcBytes: () => p.feeder.rtcBytesSent,
              getBufferState: () => ({
                producerBytes: result.output?.readableLength || 0,
                pipelineBytes: 0,
                pipelineCapacityBytes: 0
              }),
              getVoiceConnection: () => link.streamer.voiceConnection?.streamConnection,
              log: (level, message) => log(level, message) });
            piece.telemetry.start();
          } catch {}
          await this._prebuffer(result.output, piece);
          appendTask = p.feeder.append(result.output, piece.control.signal, frameMs => {
            if (Number.isFinite(frameMs) && frameMs > 0) {
              piece.playedSec = (piece.playedSec || 0) + frameMs / 1000;
              lastVideoFrameAt = Date.now();
            }
          }, { syncVideoToAudio: piece.isLive || piece.isFiller });
          if (!piece.isLive && !piece.isFiller && piece.sourceInput) {
            const configuredMs = Number(this.config.vodStallTimeoutMs);
            const timeoutMs = Number.isFinite(configuredMs) && configuredMs > 0 ? configuredMs : 8000;
            stallWatchdog = setInterval(() => {
              if (p.feeder.connection?.ready === false) {
                if (lastVideoFrameAt) lastVideoFrameAt = Date.now();
                return;
              }
              if (lastVideoFrameAt && !piece.control.signal.aborted &&
                  Date.now() - lastVideoFrameAt >= timeoutMs) {
                const error = new Error('VOD video stopped producing frames');
                error.code = 'VIDEO_STALL';
                failure(error);
              }
            }, Math.max(20, Math.min(1000, timeoutMs / 2)));
            stallWatchdog.unref?.();
          }
          await Promise.all([appendTask, completion]);
          if (!piece.control.signal.aborted && piece.isLive) recoverLive = true;
          else if (!piece.control.signal.aborted && !piece.isFiller) {
            const remaining = Number(piece.totalDurationSec) - this.positionOf(piece);
            if (piece.sourceInput && Number.isFinite(piece.totalDurationSec) &&
                piece.totalDurationSec > 0 && remaining > 30) {
              recoverVod = true;
              vodRecoveryReason = 'early EOF';
            } else this._notifyEnded(piece, clean);
          }
        } catch (error) {
          if (!piece.control.signal.aborted && !p.closed) {
            if (piece.isLive) { recoverLive = true; liveError = error; }
            else if (piece.sourceInput && !piece.isFiller) {
              recoverVod = true;
              vodRecoveryReason = error.code === 'AV_SYNC_LOST' ? 'audio/video sync lost'
                : error.code === 'VIDEO_STALL' ? 'video stalled' : 'FFmpeg error';
            }
            else this._notifyError(`ffmpeg error: ${error.message}`);
          }
        } finally {
          if (stallWatchdog) clearInterval(stallWatchdog);
          this._cancelPiece(piece);
          await appendTask?.catch(() => {});
          await this._reapPiece(piece);
          if (this.session === piece) this.session = null;
          p.activeWriter = null;
        }
        if (recoverLive && !p.closed && !link.paused && p.enqueue.length === 0) {
          const activeMs = Date.now() - piece.startedAt;
          const attempt = activeMs >= 30000 ? 1 : (piece.recoveryAttempt || 0) + 1;
          if (attempt <= 8) {
            const retryDelayMs = Math.min(1000 * 2 ** (attempt - 1), 10000);
            const retry = this._reopenSession(link, piece, { offsetSec: 0 });
            retry.recoveryAttempt = attempt;
            retry.retryDelayMs = retryDelayMs;
            p.enqueue.unshift(retry);
            log('warn', `live source interrupted; retry ${attempt}/8 in ${retryDelayMs}ms${liveError ? ' after ffmpeg error' : ' after EOF'}`);
          } else {
            this._notifyError('Live stream could not be recovered after 8 attempts');
          }
        }
        if (recoverVod && !p.closed && !link.paused && p.enqueue.length === 0) {
          const activeMs = Date.now() - piece.startedAt;
          const attempt = activeMs >= 30000 ? 1 : (piece.recoveryAttempt || 0) + 1;
          const offsetSec = Math.round(this.positionOf(piece));
          if (attempt <= 3 && (!piece.totalDurationSec || offsetSec < piece.totalDurationSec - 5)) {
            const retry = this._reopenSession(link, piece, { offsetSec });
            retry.recoveryAttempt = attempt;
            retry.retryDelayMs = Math.min(attempt * 1000, 3000);
            p.enqueue.unshift(retry);
            log('warn', `VOD ${vodRecoveryReason}; reopening at ${offsetSec}s (attempt ${attempt}/3)`);
          } else {
            this._notifyError('VOD playback could not be recovered');
          }
        }
      }
    })().finally(() => {
      p.writerTask = null;
      if (p.closed) return;
      // PAUSE-HOLD: while a pause is requested, the active writer was just
      // cancelled but the queued items are HELD — do not advance to the next
      // piece and do NOT start the leave/grace timer. The muxer + go-live
      // session stay open. $resume re-enqueues the held session and pumps.
      if (link.paused) {
        log('info', `pause-hold: link ${link.channelId} holding queue (grace suppressed)`);
        return;
      }
      if (p.enqueue.length) this._pump(link, videoModule);
      else this._startGraceTimer(link, 'queue empty');
    });
    p.writerTask.catch(error => this._notifyError(`content queue failed: ${error.message}`));
  }

  async _leaveVoiceLink(link) {
    if (!link) return;
    if (link.closing) return link.closing;
    link.closing = (async () => {
      this._clearGraceTimer(link);
      const p = link.pipeline;
      if (p) {
        p.closed = true;
        p.enqueue.length = 0;
        clearInterval(p.watchdog);
        if (p.burstEndTimer) { clearTimeout(p.burstEndTimer); p.burstEndTimer = null; }
        p.resolveReady(false);
        p.control.abort(); // playStream's normal cleanup owns stopStream
        // Before its abort listener exists (demux/handshake), explicitly stop.
        if (link.streamer.voiceConnection?.streamConnection) {
          try { link.streamer.stopStream(); } catch (error) {
            log('error', `voice: stopStream failed: ${error.message}`);
          }
        }
        this._cancelPiece(p.activeWriter);
        p.feeder.interrupt();
      }
      // Leaving voice must not depend on native demuxer/FFmpeg cleanup. A
      // stalled writer can take the full cleanup timeout (or block in native
      // code), while the user has already asked to leave the call.
      if (this.session?.voiceLink === link) this.session = null;
      try { link.streamer.leaveVoice(); } catch (error) {
        log('error', `voice: leaveVoice failed: ${error.message}`);
      }
      if (this.voiceLink === link) this.voiceLink = null;
      if (p) {
        // Start native demux cleanup BEFORE waiting for writerTask. The writer
        // can itself be blocked in demux(), so the old ordering deadlocked:
        // writer waited for demux close while teardown waited for writer.
        const demuxCleanup = demuxGuard.closeAllDemuxers();
        const cleanupTimeoutMs = this._cleanupTimeoutMs();
        try {
          await this._raceWithTimeout(
            Promise.allSettled([p.writerTask, demuxCleanup, p.feeder.close()]),
            cleanupTimeoutMs,
            `stream cleanup timed out after ${cleanupTimeoutMs}ms`
          );
        } catch (error) {
          // A dead native demuxer must never retain the serialized command
          // queue. Its inputs/processes are already aborted and destroyed.
          log('error', `voice: ${error.message}; continuing forced teardown`);
        }
      }
    })();
    return link.closing;
  }

  async stop() {
    return this._serialize(async () => {
      if (this.voiceLink) await this._leaveVoiceLink(this.voiceLink);
      else if (this.session) await this.teardown(this.session);
      return true;
    });
  }

  async leaveChannel() { await this.stop(); }

  // Compatibility for callers holding an old piece. Never ends only its track.
  async teardown(piece) {
    if (piece?.voiceLink) return this._leaveVoiceLink(piece.voiceLink);
    if (!piece) return;
    piece.streamer?.stopStream?.();
    piece.control?.abort?.();
    piece.command?.kill?.('SIGTERM');
    piece.output?.destroy?.();
    piece.telemetry?.stop?.();
    await demuxGuard.closeAllDemuxers();
    if (piece.streamer && piece.streamer === this._streamer) piece.streamer.leaveVoice?.();
    if (this.session === piece) this.session = null;
  }

  _fillerOnJoin() { return this.config.fillerOnJoin !== false; }
  _fillerDurationSec() {
    return this.config.fillerDurationSec > 0 ? this.config.fillerDurationSec : Math.max(this._graceMs() / 500, 300);
  }

  _placeholder(link) {
    return this._piece(link, { streamUrl: 'testsrc=size=1280x720:rate=30', inputFormat: 'lavfi',
      durationSec: this._fillerDurationSec(), isFiller: true, title: 'placeholder' });
  }

  // Short filler inserted BEFORE a new real piece when a real piece is already
  // active or queued, so the transition between real streams is a clean
  // "…current real → N-second filler → new real". Uses the SAME testsrc/lavfi
  // path as the join placeholder (identical output codec params) so it always
  // coexists with real content on the persistent NUT muxer.
  //
  // Enabled unless the operator explicitly set the duration to 0. (The config
  // loader defaults to 15; tests that want a deterministic "no buffer" state
  // pass streamBufferSec: 0.)
  _gapFillerEnabled() {
    return this.config.streamBufferSec !== 0;
  }

  _gapFillerDurationSec() {
    return this.config.streamBufferSec > 0 ? this.config.streamBufferSec : 15;
  }

  _gapFiller(link) {
    return this._piece(link, { streamUrl: 'testsrc=size=1280x720:rate=30', inputFormat: 'lavfi',
      durationSec: this._gapFillerDurationSec(), isFiller: true, title: 'buffer' });
  }

  _piece(link, args) {
    const isFiller = !!args.isFiller;
    // isLive: continuous live feed (HLS/MPEG-TS) → not seekable; a VOD/filler
    // is seekable. Filler (local testsrc) is NOT live. totalDurationSec is
    // null when unknown (live streams, most direct VODs); fillers carry their
    // fixed duration. sourceUrl = the re-openable http(s) url for the piece
    // (DASH reopens from videoUrl/audioUrl). Backward compatible: purely
    // additive, existing consumers ignore the extra fields.
    const isLive = isFiller ? false : (args.isLive === true);
    const totalDurationSec = isFiller
      ? (Number.isFinite(args.durationSec) ? args.durationSec : null)
      : (Number.isFinite(args.totalDurationSec) ? args.totalDurationSec : null);
    const sourceUrl = isFiller
      ? (args.streamUrl || null)
      : (args.videoUrl || args.audioUrl || args.streamUrl || null);
    return { ...args, guildId: link.guildId, channelId: link.channelId,
      streamer: link.streamer, voiceLink: link, control: new AbortController(),
      startedAt: Date.now(), isFiller, isDash: !!(args.videoUrl && args.audioUrl),
      playType: 'go-live', isLive, totalDurationSec, sourceUrl };
  }

  async ensureChannel(guildId, channelId) {
    if (!guildId || !channelId) return { ok: false, message: M.STREAM_NEED_CHANNEL };
    const result = await this._serialize(async () => {
      const channel = this.client.channels.cache.get(channelId) || await this.client.channels.fetch(channelId);
      if (!channel) return { ok: false, message: M.STREAM_NO_CHANNEL };
      const videoModule = await this.preparePlayback(await this._video());
      const r = await this._ensureVoiceLink(guildId, channelId, videoModule);
      if (!r.ok) return r;
      const link = r.voiceLink;
      let fillerStarted = false;
      if (!link.pipeline && this._fillerOnJoin()) {
        const p = this._ensurePipeline(link, videoModule);
        p.enqueue.push(this._placeholder(link));
        this._pump(link, videoModule);
        fillerStarted = true;
      } else if (!link.pipeline?.activeWriter && !link.pipeline?.enqueue.length) {
        this._startGraceTimer(link, 'join renewed');
      }
      return { ...r, fillerStarted };
    });
    if (result.ok && result.voiceLink.pipeline && !await result.voiceLink.pipeline.ready) {
      return { ok: false, message: M.STREAM_PLAY_STREAM_HANG };
    }
    return result;
  }

  async startFiller(guildId, channelId) { return this.ensureChannel(guildId, channelId); }

  status() {
    const link = this.voiceLink;
    if (!link) return null;
    const piece = this.session;
    return { guildId: link.guildId, channelId: link.channelId,
      streamUrl: piece?.videoUrl || piece?.streamUrl || null, title: piece?.title || null,
      startedAt: piece?.startedAt || link.joinedAt,
      elapsedMs: Date.now() - (piece?.startedAt || link.joinedAt),
      alive: !link.closing, inChannel: true, isFiller: !!piece?.isFiller,
      queued: link.pipeline?.enqueue.length || 0,
      paused: !!link.paused, isLive: !!piece?.isLive,
      positionSec: piece ? Math.round(this.positionOf(piece)) : null };
  }

  async start(args = {}) {
    const { guildId, channelId, streamUrl, videoUrl, audioUrl, isLive, totalDurationSec } = args;
    if (!guildId || !channelId) return { ok: false, message: M.STREAM_NEED_CHANNEL };
    const dash = !!(videoUrl && audioUrl);
    if (dash ? !isHttpUrl(videoUrl) || !isHttpUrl(audioUrl) : !this._validInput(streamUrl)) {
      return { ok: false, message: M.STREAM_BAD_URL };
    }
    const result = await this._serialize(async () => {
      const channel = this.client.channels.cache.get(channelId) || await this.client.channels.fetch(channelId);
      if (!channel) return { ok: false, message: M.STREAM_NO_CHANNEL };
      const videoModule = await this.preparePlayback(await this._video());
      const r = await this._ensureVoiceLink(guildId, channelId, videoModule);
      if (!r.ok) return r;
      const link = r.voiceLink;
      const p = this._ensurePipeline(link, videoModule);
      if (p.enqueue.length >= (this.config.streamQueueLimit || 20)) {
        return { ok: false, message: 'The stream queue is full. Wait for a video to finish or use $stop.' };
      }
      const piece = this._piece(link, args);
      const queued = !!p.activeWriter && !p.activeWriter.isFiller;
      // Insert a short filler buffer immediately BEFORE the new real piece
      // when a REAL piece is already active or queued (so playback is
      // "…current real → buffer → new real"). NO buffer before the first real
      // on an otherwise-idle/placeholder pipeline (a fresh join placeholder is
      // isFiller and must not count as real-ahead). The buffer is a separate
      // FIFO piece, so $skip (cancel active) lands on it, then the next real.
      const realAhead = (p.activeWriter && !p.activeWriter.isFiller) || p.enqueue.some(q => !q.isFiller);
      const bufferInserted = realAhead && this._gapFillerEnabled();
      if (bufferInserted) p.enqueue.push(this._gapFiller(link));
      p.enqueue.push(piece);
      // Only the placeholder is interruptible. Real content is always FIFO.
      if (p.activeWriter?.isFiller) this._cancelPiece(p.activeWriter);
      this._pump(link, videoModule);
      return { ok: true, session: piece, pipeline: p, chained: !!r.reused, queued, bufferInserted };
    });
    if (result.ok && !await result.pipeline.ready) return { ok: false, message: M.STREAM_PLAY_STREAM_HANG };
    return result;
  }

  // $skip: cancel the currently active piece and let the pump advance to the
  // next queued item. Buffers are separate filler pieces between reals, so a
  // skip of a real lands on the buffer, then the next real. If the queue goes
  // empty (nothing real and nothing buffered ahead) fall back to the join
  // placeholder so the channel never goes silent. No-op when there is nothing
  // active and nothing queued. Serialized so it can't interleave with an
  // in-flight pump iteration; the pump itself drives the transition.
  async skip() {
    return this._serialize(async () => {
      const link = this.voiceLink;
      const p = link?.pipeline;
      const active = p?.activeWriter;
      if (!active && !(p?.enqueue && p.enqueue.length)) {
        return { ok: true, noOp: true, skippedTo: null, fellBackToFiller: false, queued: p ? p.enqueue.length : 0 };
      }
      let fellBackToFiller = false;
      if (active) this._cancelPiece(active);
      if (p && p.enqueue.length === 0) {
        p.enqueue.push(this._placeholder(link));
        fellBackToFiller = true;
      }
      if (p && !p.writerTask) {
        const videoModule = await this.preparePlayback(await this._video());
        this._pump(link, videoModule);
      }
      const queue = (p && p.enqueue) || [];
      const nextReal = queue.find(q => !q.isFiller);
      const skippedTo = nextReal ? nextReal.title : (fellBackToFiller ? 'placeholder' : null);
      return { ok: true, noOp: false, skippedTo, fellBackToFiller, queued: p ? p.enqueue.length : 0 };
    });
  }

  // Current playback position in seconds for a piece: the starting offset
  // plus the wall-clock elapsed since the piece began, clamped to >=0 and (when
  // the piece has a finite totalDurationSec) to <= that duration. Used by
  // scrub/pause to know where to resume from. Never throws.
  positionOf(piece) {
    if (!piece) return 0;
    const base = Number.isFinite(piece.startOffsetSec) && piece.startOffsetSec > 0 ? piece.startOffsetSec : 0;
    // A stalled encoder/source advances wall time without advancing the
    // viewer's video. Once frames have been sent, seek from their duration.
    const elapsed = Number.isFinite(piece.playedSec) && piece.playedSec > 0
      ? piece.playedSec
      : Math.max(0, (Date.now() - (piece.startedAt || Date.now())) / 1000);
    let pos = base + elapsed;
    if (pos < 0) pos = 0;
    if (Number.isFinite(piece.totalDurationSec) && piece.totalDurationSec > 0 && pos > piece.totalDurationSec) {
      pos = piece.totalDurationSec;
    }
    return pos;
  }

  // Re-open the CURRENT real (non-filler) content as a fresh piece at a new
  // offset. Reuses the exact same content fields (streamUrl/videoUrl/audioUrl/
  // inputFormat/durationSec/title) so the pump's dash-vs-single routing is
  // byte-for-byte unchanged — only startOffsetSec/isLive/totalDurationSec move.
  // `title` is preserved so status/notifications keep the original label.
  _reopenSession(link, piece, { offsetSec, isLive, totalDurationSec } = {}) {
    const off = Number.isFinite(offsetSec) ? Math.max(0, Math.round(offsetSec)) : (Number.isFinite(piece.startOffsetSec) ? piece.startOffsetSec : 0);
    return this._piece(link, {
      streamUrl: piece.streamUrl,
      videoUrl: piece.videoUrl,
      audioUrl: piece.audioUrl,
      sourceInput: piece.sourceInput,
      inputFormat: piece.inputFormat,
      durationSec: piece.durationSec,
      title: piece.title,
      startOffsetSec: off,
      isLive: isLive !== undefined ? isLive : piece.isLive,
      totalDurationSec: totalDurationSec !== undefined ? totalDurationSec : piece.totalDurationSec
    });
  }

  _copyQueuedPiece(link, piece) {
    if (piece.isFiller) {
      return this._piece(link, {
        streamUrl: piece.streamUrl,
        inputFormat: piece.inputFormat,
        durationSec: piece.durationSec,
        isFiller: true,
        title: piece.title
      });
    }
    return this._reopenSession(link, piece, {
      offsetSec: Number.isFinite(piece.startOffsetSec) ? piece.startOffsetSec : 0
    });
  }

  // Discord can move this account to another call without a join command.
  // discord-video-stream keeps its old channelId in that case, so its voice
  // and Go Live sockets are no longer usable. Rebuild only on the matching
  // self VOICE_STATE_UPDATE; there is no polling or media-path overhead.
  async handleVoiceStateUpdate(packet) {
    if (packet?.t !== 'VOICE_STATE_UPDATE') return { ok: true, ignored: true };
    const state = packet.d;
    if (!state || state.user_id !== this.client.user?.id || !state.channel_id) {
      return { ok: true, ignored: true };
    }

    return this._serialize(async () => {
      const oldLink = this.voiceLink;
      const guildId = state.guild_id || oldLink?.guildId;
      const channelId = state.channel_id;
      if (!oldLink || oldLink.closing || oldLink.guildId !== guildId || oldLink.channelId === channelId) {
        return { ok: true, ignored: true };
      }

      const oldPipeline = oldLink.pipeline;
      const active = oldPipeline?.activeWriter || null;
      const activePosition = active && !active.isFiller && !active.isLive ? this.positionOf(active) : 0;
      const queued = oldPipeline ? [...oldPipeline.enqueue] : [];
      const wasPaused = !!oldLink.paused;
      const pausedSession = oldLink.pausedSession || null;
      const pausedPosition = Number.isFinite(oldLink.pausedPositionSec)
        ? oldLink.pausedPositionSec
        : (pausedSession && !pausedSession.isLive ? this.positionOf(pausedSession) : 0);

      log('info', `voice: moved externally ${oldLink.channelId} -> ${channelId}; reopening Go Live session`);
      const videoModule = await this.preparePlayback(await this._video());
      const joined = await this._ensureVoiceLink(guildId, channelId, videoModule);
      if (!joined.ok) return joined;
      const newLink = joined.voiceLink;

      // A voice-only join has no Go Live session to restore.
      if (!oldPipeline) return { ok: true, moved: true, voiceLink: newLink };

      const pipeline = this._ensurePipeline(newLink, videoModule);
      if (wasPaused) {
        newLink.paused = true;
        newLink.pausedAt = oldLink.pausedAt || Date.now();
        newLink.pausedPositionSec = pausedPosition;
        newLink.pausedSession = pausedSession ? this._copyQueuedPiece(newLink, pausedSession) : null;
      } else if (active) {
        pipeline.enqueue.push(active.isFiller
          ? this._copyQueuedPiece(newLink, active)
          : this._reopenSession(newLink, active, { offsetSec: active.isLive ? 0 : activePosition }));
      } else if (queued.length === 0) {
        pipeline.enqueue.push(this._placeholder(newLink));
      }
      for (const piece of queued) pipeline.enqueue.push(this._copyQueuedPiece(newLink, piece));
      if (!wasPaused) this._pump(newLink, videoModule);
      log('info', `voice: move recovery reopened Go Live in ${channelId}; restored=${active?.title || (wasPaused ? pausedSession?.title : 'filler') || 'filler'} queued=${queued.length}`);
      return { ok: true, moved: true, voiceLink: newLink, pipeline };
    });
  }

  // Resolve the active real (non-filler) writer for the current voice link,
  // falling back to this.session when it is a real piece. Null when only a
  // filler (or nothing) is active — the "no content" case.
  _activeRealSession() {
    const link = this.voiceLink;
    const p = link?.pipeline;
    const active = p?.activeWriter;
    if (active && !active.isFiller) return { link, p, session: active };
    if (this.session && !this.session.isFiller) {
      return { link: this.session.voiceLink || link, p: (this.session.voiceLink || link)?.pipeline || p, session: this.session };
    }
    return { link, p, session: null };
  }

  // $scrub <signed duration>: advance/rewind a SEEKABLE (VOD) piece by delta
  // seconds. Reopens the piece at the new position; live streams and fillers
  // are graceful no-ops (see M.SCRUB_LIVE / SCRUB_NEED_CONTENT). Never tears
  // down the persistent go-live session or the shared muxer.
  async scrub(deltaSec) {
    return this._serialize(async () => {
      const { link, session } = this._activeRealSession();
      if (!link || !session || session.isFiller) return { ok: true, noOp: true, reason: 'filler' };
      if (session.isLive) return { ok: true, noOp: true, applied: false, reason: 'live' };
      let pos = this.positionOf(session) + deltaSec;
      if (pos < 0) pos = 0;
      const dur = session.totalDurationSec;
      if (Number.isFinite(dur) && dur > 0 && pos > dur) pos = dur;
      const piece = this._reopenSession(link, session, { offsetSec: pos });
      this._cancelPiece(session);
      this.session = piece;
      const p = link.pipeline;
      p.enqueue.push(piece);
      if (!p.writerTask) {
        const videoModule = await this.preparePlayback(await this._video());
        this._pump(link, videoModule);
      }
      return { ok: true, applied: true, newPosSec: Math.round(pos), title: piece.title };
    });
  }

  // $pause: best-effort "freeze" — stop feeding the muxer (hold the last
  // frame) while keeping the go-live session + muxer OPEN and the queue held.
  // Does NOT advance the queue, NOT start grace, NOT tear down. Bounded by
  // maxPauseSec (best-effort; resume still works and reports the held duration).
  async pause() {
    return this._serialize(async () => {
      const { link, session } = this._activeRealSession();
      if (!link || !session || session.isFiller) return { ok: true, noOp: true, reason: 'filler' };
      if (link.paused) return { ok: true, noOp: true, reason: 'already-paused' };
      link.paused = true;
      link.pausedAt = Date.now();
      link.pausedSession = session;
      link.pausedPositionSec = this.positionOf(session);
      this._cancelPiece(session); // stops feeding; the .finally holds (no advance)
      return { ok: true, paused: true, heldSec: 0 };
    });
  }

  // $resume: re-open the paused session (VOD at the held position, LIVE at the
  // head) and restart the pump. No-op when not paused. Never tears down.
  async resume() {
    return this._serialize(async () => {
      const link = this.voiceLink;
      if (!link) return { ok: true, noOp: true, reason: 'no-link' };
      if (!link.paused) return { ok: true, noOp: true, reason: 'not-paused' };
      const heldSec = Math.round((Date.now() - (link.pausedAt || Date.now())) / 1000);
      const pausedSession = link.pausedSession;
      link.paused = false;
      link.pausedAt = null;
      link.pausedSession = null;
      let piece = null;
      if (pausedSession && !pausedSession.isFiller) {
        const offset = pausedSession.isLive ? 0 : (Number.isFinite(link.pausedPositionSec) ? link.pausedPositionSec : 0);
        piece = this._reopenSession(link, pausedSession, { offsetSec: offset });
      } else {
        // Paused while only a filler was active: restore a placeholder so the
        // channel is not left silent.
        piece = this._placeholder(link);
      }
      link.pausedPositionSec = null;
      const p = link.pipeline;
      // Front-inject: "resume" continues the SAME stream where it paused, so it
      // plays before any backlog queued during the pause.
      p.enqueue.unshift(piece);
      if (!p.writerTask) {
        const videoModule = await this.preparePlayback(await this._video());
        this._pump(link, videoModule);
      }
      return { ok: true, resumed: true, heldSec };
    });
  }

  // $catchup: jump a LIVE piece to the live head (offset 0). For a VOD
  // (not-live) this is a graceful no-op (best-effort, no forced restart).
  // Fillers are no-ops. Reuses the same swap mechanism as scrub.
  async catchup() {
    return this._serialize(async () => {
      const { link, session } = this._activeRealSession();
      if (!link || !session || session.isFiller) return { ok: true, noOp: true, reason: 'filler' };
      if (!session.isLive) return { ok: true, applied: false, reason: 'not-live' };
      const piece = this._reopenSession(link, session, { offsetSec: 0, isLive: true });
      this._cancelPiece(session);
      this.session = piece;
      const p = link.pipeline;
      p.enqueue.push(piece);
      if (!p.writerTask) {
        const videoModule = await this.preparePlayback(await this._video());
        this._pump(link, videoModule);
      }
      return { ok: true, applied: true, title: piece.title };
    });
  }

  // Deliver the user-facing end feedback WITHOUT any channel send: the bot
  // account is restricted and can no longer send messages. The same text the
  // old channel.send(path) would have used (M.STREAM_VOD_ENDED /
  // M.STREAM_VOD_STOPPED — `clean` selects which one) is logged locally
  // (redacted) and, if TELEMETRY_WEBHOOK_URL is configured, POSTed to the
  // alert webhook (event 'stream-ended').
  // Idempotent per content piece. playStream completion is a whole-pipeline
  // event and must never be mistaken for successful content completion.
  _notifyEnded(session, clean) {
    if (!session || session.notifiedEnded) return;
    session.notifiedEnded = true;
    const text = this._sanitize(clean ? M.STREAM_VOD_ENDED(session.title) : M.STREAM_VOD_STOPPED);
    log('info', `(no-send) ${text}`);
    try {
      void this.alertSink.notify('stream-ended', text).catch(() => {});
    } catch { /* sink never throws */ }
  }

  _ffmpegCommandString(command) {
    try {
      if (command && typeof command.getCommand === 'function') {
        const parts = command.getCommand();
        if (typeof parts === 'string') return parts;
        if (Array.isArray(parts)) return parts.join(' ');
      }
      if (command && typeof command._getArguments === 'function') {
        const parts = command._getArguments();
        if (Array.isArray(parts)) return parts.join(' ');
        if (typeof parts === 'string') return parts;
      }
    } catch { /* fall through */ }
    return '(unavailable)';
  }
}

module.exports = { StreamManager, isAmbiguousPipeClose, isBenignEnd };
