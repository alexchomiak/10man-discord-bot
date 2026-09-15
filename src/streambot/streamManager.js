'use strict';

const { M } = require('./messages');
const { TAG, redactToken } = require('./config');

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
    return {
      width: cfg.streamWidth || 1920,
      height: cfg.streamHeight || 1080,
      frameRate: cfg.streamFrameRate || 30,
      videoCodec: codec,
      bitrateVideo: bitrate,
      bitrateVideoMax: Math.round(bitrate * 1.4),
      includeAudio: true,
      hardwareAcceleratedDecoding: !!cfg.hardwareAccel,
      minimizeLatency: true
    };
  }

  _sanitize(text) {
    return redactToken(String(text || ''), this.client?.token);
  }

  teardown(session) {
    if (!session) return;
    try { session.streamer && session.streamer.stopStream && session.streamer.stopStream(); } catch {}
    try { session.control && session.control.abort && session.control.abort(); } catch {}
    try { session.command && session.command.kill && session.command.kill('SIGKILL'); } catch {}
    try { session.output && session.output.destroy && session.output.destroy(); } catch {}
    try { session.streamer && session.streamer.leaveVoice && session.streamer.leaveVoice(); } catch {}
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

  async start({ guildId, channelId, streamUrl, title } = {}) {
    if (!guildId || !channelId) {
      return { ok: false, message: M.STREAM_NEED_CHANNEL };
    }
    if (!streamUrl || !/^https?:\/\//i.test(String(streamUrl))) {
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

    const streamer = new Streamer(this.client);

    let webRtc = null;
    try {
      webRtc = await streamer.joinVoice(guildId, channelId);
    } catch (e) {
      this.teardown({ streamer });
      return { ok: false, message: this._sanitize((e && e.message) || M.STREAM_JOIN_FAILED) };
    }

    const options = this.setupStreamOptions(videoModule);
    const control = new AbortController();

    let result;
    try {
      result = prepareStream(streamUrl, options, control.signal);
    } catch (e) {
      this.teardown({ streamer });
      return { ok: false, message: this._sanitize((e && e.message) || M.STREAM_START_FAILED) };
    }
    if (!result || !result.output || !result.command) {
      this.teardown({ streamer });
      return { ok: false, message: M.STREAM_START_FAILED };
    }

    const session = {
      guildId,
      channelId,
      streamUrl,
      title: title || null,
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
      }
    });

    void playStream(result.output, streamer, undefined, control.signal)
      .then(() => {
        if (this.session === session) {
          this.session = null;
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

    log('info', `streaming ${streamUrl} -> channel ${channelId}`);
    return { ok: true, session };
  }
}

module.exports = { StreamManager };
