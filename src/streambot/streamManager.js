'use strict';

const { M } = require('./messages');
const { TAG, redactToken } = require('./config');
const fs = require('fs');
const path = require('path');

function log(level, parts) {
  if (level === 'error') console.error(TAG, ...parts);
  else console.log(TAG, ...parts);
}

class StreamManager {
  constructor(client, defaultChannelId = null, config = null) {
    this.client = client;
    this.defaultChannelId = defaultChannelId;
    this.config = config || {};
    this.session = null;
    this._videoModule = null;
    // A single shared Streamer for the manager's lifetime: `new Streamer()`
    // attaches a permanent client.on('raw') listener, so per-session instances
    // leak listeners on every start().
    this._streamer = null;
  }

  _getStreamer(videoModule) {
    if (!this._streamer) this._streamer = new videoModule.Streamer(this.client);
    return this._streamer;
  }

  async _video() {
    if (this._videoModule) return this._videoModule;
    this._videoModule = await import('@dank074/discord-video-stream');
    return this._videoModule;
  }

  setupStreamOptions(videoModule) {
    const cfg = this.config;
    const codec = videoModule.Utils
      ? videoModule.Utils.normalizeVideoCodec(cfg.videoCodec || 'H264')
      : (cfg.videoCodec || 'H264').toUpperCase();
    const bitrate = Number.isFinite(cfg.streamBitrate) ? cfg.streamBitrate : 5000;
    const width = -2; // library convention: negative = scale by aspect ratio (ffmpeg scale=-2:H)
    const height = Number.isFinite(cfg.streamHeight) && cfg.streamHeight > 0 ? cfg.streamHeight : 1080;
    log('info', `stream options: width=${width} (auto, AR-preserving), height=${height}, codec=${codec}`);
    return {
      width,
      height,
      frameRate: cfg.streamFrameRate || 30,
      videoCodec: codec,
      bitrateVideo: bitrate,
      bitrateVideoMax: Math.round(bitrate * 1.4),
      includeAudio: true,
      hardwareAcceleratedDecoding: !!cfg.hardwareAccel,
      minimizeLatency: false,
      h26xPreset: 'ultrafast'
    };
  }

  _sanitize(text) {
    return redactToken(String(text || ''), this.client?.token);
  }

  // Accept an http(s) stream URL OR an existing local file (DASH VODs are
  // downloaded + merged to a local file before streaming).
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

  _cleanupLocal(session) {
    const dir = session && session.localDir;
    if (!dir) return;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
  }

  _ffmpegCommandString(command) {
    try {
      if (command && typeof command.getCommand === 'function') {
        const parts = command.getCommand();
        if (typeof parts === 'string') return parts;
        if (Array.isArray(parts)) return parts.join(' ');
      }
    } catch { /* fall through */ }
    return '(unavailable)';
  }

  teardown(session) {
    if (!session) return;
    this._cleanupLocal(session);
    try { session.streamer && session.streamer.stopStream && session.streamer.stopStream(); } catch {}
    try { session.control && session.control.abort && session.control.abort(); } catch {}
    try {
      const command = session.command;
      if (command && typeof command.kill === 'function') {
        command.kill('SIGTERM');
        // Safety net: escalate to SIGKILL if ffmpeg is still alive after 2s.
        setTimeout(() => {
          try {
            const proc = command.process;
            if (!proc || proc.exitCode === null) command.kill('SIGKILL');
          } catch {}
        }, 2000).unref();
      }
    } catch {}
    try { session.output && session.output.destroy && session.output.destroy(); } catch {}
    if (session.streamer && session.streamer === this._streamer) {
      try { session.streamer.leaveVoice(); } catch {}
    }
  }

  stop() {
    const session = this.session;
    this.session = null;
    this.teardown(session);
    return true;
  }

  status() {
    const session = this.session;
    if (!session) return null;
    const now = Date.now();
    return {
      guildId: session.guildId,
      channelId: session.channelId,
      streamUrl: session.streamUrl,
      title: session.title || null,
      startedAt: session.startedAt,
      elapsedMs: now - session.startedAt,
      alive: session.control ? !session.control.signal.aborted : true
    };
  }

  async start({ guildId, channelId, streamUrl, title, localDir } = {}) {
    if (!guildId || !channelId) {
      return { ok: false, message: M.STREAM_NEED_CHANNEL };
    }
    if (!streamUrl || !this._validInput(String(streamUrl))) {
      return { ok: false, message: M.STREAM_BAD_URL };
    }

    let channel = null;
    try {
      channel = this.client.channels.cache.get(channelId) || (await this.client.channels.fetch(channelId));
    } catch (e) {
      log('error', 'channel resolve failed:', this._sanitize(e && e.message));
    }
    if (!channel) {
      return { ok: false, message: M.STREAM_NO_CHANNEL };
    }

    await this.stop();

    let videoModule;
    try {
      videoModule = await this._video();
    } catch (e) {
      return { ok: false, message: this._sanitize((e && e.message) || M.STREAM_START_FAILED) };
    }
    const { Streamer, prepareStream, playStream } = videoModule;

    const ffmpegPath = this.config.ffmpegPath;
    if (ffmpegPath) {
      try {
        const ffmpeg = require('fluent-ffmpeg');
        ffmpeg.setFfmpegPath(ffmpegPath);
      } catch (e) {
        log('error', 'setFfmpegPath failed:', this._sanitize(e && e.message));
      }
    }

    const streamer = this._getStreamer(videoModule);

    let webRtc = null;
    try {
      webRtc = await streamer.joinVoice(guildId, channelId);
    } catch (e) {
      this.teardown({ streamer, localDir });
      return { ok: false, message: this._sanitize((e && e.message) || M.STREAM_JOIN_FAILED) };
    }

    const options = this.setupStreamOptions(videoModule);
    const control = new AbortController();

    let result;
    try {
      result = prepareStream(streamUrl, options, control.signal);
    } catch (e) {
      this.teardown({ streamer, localDir });
      return { ok: false, message: this._sanitize((e && e.message) || M.STREAM_START_FAILED) };
    }
    if (!result || !result.output || !result.command) {
      this.teardown({ streamer, localDir });
      return { ok: false, message: M.STREAM_START_FAILED };
    }

    log('info', `ffmpeg: ${this._ffmpegCommandString(result.command)}`);

    const session = {
      guildId,
      channelId,
      streamUrl,
      title: title || null,
      localDir: localDir || null,
      startedAt: Date.now(),
      streamer,
      control,
      command: result.command,
      output: result.output,
      promise: result.promise,
      webRtc,
      volume: result.controller || null
    };
    this.session = session;

    result.command.on('error', (err) => {
      log('error', `ffmpeg error: ${this._sanitize(err && err.message)}`);
      if (this.session === session) {
        this.session = null;
        this.teardown(session);
      }
    });
    result.output.on('error', (err) => {
      log('error', `stream output error: ${this._sanitize(err && err.message)}`);
      if (this.session === session) {
        this.session = null;
        this.teardown(session);
      }
    });
    result.output.on('close', () => {
      if (this.session === session && !control.signal.aborted) {
        log('info', 'stream closed');
        this.session = null;
        this._cleanupLocal(session);
      }
    });

    // Watchdog: the library awaits go-live gateway opcodes (STREAM_CREATE +
    // STREAM_SERVER_UPDATE) with NO timeout, so a selfbot token without those
    // opcodes deafens and hangs silently forever. playStream() itself only
    // settles when the stream ENDS, so instead we watch the handshake state:
    // streamConnection only becomes usable once the gateway has acked the
    // start. If it never does within the window, tear down and tell the user.
    // The AbortController above remains the canonical stop mechanism.
    const timeoutMs = Number.isFinite(this.config.playStreamStartTimeoutMs) && this.config.playStreamStartTimeoutMs > 0
      ? this.config.playStreamStartTimeoutMs
      : 30000;
    const startDeadline = Date.now() + timeoutMs;
    const watchdog = { tripped: false };
    const startHandshake = new Promise((resolve) => {
      const poll = setInterval(() => {
        // The hang is: playStream() -> streamer.createStream() awaits the gateway
        // STREAM_CREATE ack, which a restricted selfbot token never sends. serverId
        // is set on exactly that ack (Streamer.js createStream -> STREAM_CREATE
        // handler), so it is the precise "the go-live handshake completed" marker.
        let started = false;
        try {
          const vc = streamer.voiceConnection;
          const sc = vc && vc.streamConnection;
          if (sc && sc.serverId) started = true;
        } catch { /* ignore */ }
        if (started) {
          clearInterval(poll);
          resolve();
          return;
        }
        if (Date.now() > startDeadline) {
          clearInterval(poll);
          watchdog.tripped = true;
          log('error', `no gateway STREAM_CREATE ack within ${timeoutMs}ms; tearing down. The selfbot token likely lacks the go-live (stream) gateway opcodes.`);
          resolve();
          return;
        }
      }, 100);
    });

    void playStream(result.output, streamer, undefined, control.signal)
      .then(() => {
        if (this.session === session) {
          this.session = null;
          this._cleanupLocal(session);
          log('info', 'stream finished');
        }
      })
      .catch((e) => {
        if (this.session === session) {
          log('error', `playStream failed: ${this._sanitize(e && e.message)}`);
          this.session = null;
          this.teardown(session);
        }
      });

    await startHandshake;
    if (watchdog.tripped) {
      if (this.session === session) this.session = null;
      this.teardown(session);
      return { ok: false, message: M.STREAM_PLAY_STREAM_HANG };
    }
    if (this.session !== session) {
      return { ok: false, message: M.STREAM_START_FAILED };
    }

    log('info', `streaming ${streamUrl} -> channel ${channelId}`);
    return { ok: true, session };
  }
}

module.exports = { StreamManager };
