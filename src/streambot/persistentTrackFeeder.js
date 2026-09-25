'use strict';

const { Writable } = require('node:stream');
const { finished } = require('node:stream/promises');
const { setTimeout: sleep } = require('node:timers/promises');
const { registerPersistentInput } = require('./demuxGuard');

// Same timestamp-driven sender used by discord-video-stream, kept here so a
// new normalized input can be attached without calling createStream again.
class TimedTrack extends Writable {
  constructor(send, type, options = {}) {
    super({ objectMode: true, highWaterMark: 0 });
    this.send = send;
    this.type = type;
    this.now = options.now || (() => performance.now());
    this.sleep = options.sleep || sleep;
    this.maxCatchupMs = Number.isFinite(options.maxCatchupMs) ? options.maxCatchupMs : 250;
    this.maxPtsJumpMs = Number.isFinite(options.maxPtsJumpMs) ? options.maxPtsJumpMs : 500;
    this.maxSyncWaitMs = Number.isFinite(options.maxSyncWaitMs) ? options.maxSyncWaitMs : 250;
    this.defaultDurationMs = Number.isFinite(options.defaultDurationMs) && options.defaultDurationMs > 0
      ? options.defaultDurationMs : (type === 'video' ? 1000 / 30 : 20);
    this.pts = undefined;
    this.previousPts = undefined;
    this.syncTrack = null;
    this.startTime = undefined;
    this.startPts = undefined;
  }

  async _write(packet, _encoding, callback) {
    try {
      const { data, pts, duration, timeBase } = packet;
      if (!data) return callback();
      const packetDurationMs = Number(duration) * timeBase.num * 1000 / timeBase.den;
      // RTP timestamps must advance for every encoded frame. If a demuxer
      // omits packet duration,
      // forwarding zero would make Discord display a run of frames at one RTP
      // timestamp. The output is CFR video and 20ms Opus, so use that clock
      // only when the packet duration is absent or invalid.
      const frameMs = Number.isFinite(packetDurationMs) && packetDurationMs > 0
        ? packetDurationMs : this.defaultDurationMs;
      const started = this.now();
      const packetPts = Number(pts) * timeBase.num * 1000 / timeBase.den;
      const ptsStep = Number.isFinite(this.previousPts) ? packetPts - this.previousPts : frameMs;
      // Live MPEG-TS feeds can jump their timestamps forward/backward after a
      // discontinuity. Treating that jump as wall time makes the sender sleep
      // for seconds, freezing video before it resumes at the new timestamp.
      // Rebase the pacing clock; RTP still advances by the normalized frame
      // duration, so delivery remains a steady 30 fps.
      if (Number.isFinite(this.previousPts) &&
          (ptsStep < 0 || Math.abs(ptsStep - frameMs) > this.maxPtsJumpMs)) {
        this.startTime = started;
        this.startPts = packetPts;
      }
      this.pts = packetPts;
      this.previousPts = packetPts;
      const other = this.syncTrack?.pts;
      let waitedForAudio = false;
      if (this.type === 'video' && !this.syncTrack?.writableEnded && Number.isFinite(other) && this.pts - other > 20) {
        let waitedMs = 0;
        while (!this.destroyed && !this.syncTrack?.writableEnded &&
          Number.isFinite(this.syncTrack?.pts) && this.pts - this.syncTrack.pts > 20 &&
          waitedMs < this.maxSyncWaitMs) {
          const waitMs = Math.min(frameMs, this.maxSyncWaitMs - waitedMs);
          await this.sleep(waitMs);
          waitedMs += waitMs;
        }
        // Never send video indefinitely ahead of audio. The feeder will fail
        // promptly so the manager can reopen both tracks at one VOD position.
        if (!this.destroyed && !this.syncTrack?.writableEnded &&
            Number.isFinite(this.syncTrack?.pts) && this.pts - this.syncTrack.pts > 20) {
          const error = new Error('Audio/video synchronization lost');
          error.code = 'AV_SYNC_LOST';
          throw error;
        }
        waitedForAudio = true;
      }
      this.send(Buffer.from(data), frameMs);
      const ended = this.now();
      this.startTime ??= started;
      this.startPts ??= this.pts;
      if (waitedForAudio) {
        this.startTime = this.startPts = undefined;
      } else {
        const mediaElapsed = this.pts - this.startPts + frameMs;
        const wallElapsed = ended - this.startTime;
        const lateBy = wallElapsed - mediaElapsed;
        if (lateBy > this.maxCatchupMs) {
          // Both remote input stalls and a congested tunnel can leave this
          // sender far behind its original wall clock. Sending every delayed
          // frame with zero sleep creates an RTP burst and makes the freeze
          // worse. Rebase at the next frame and resume steady pacing.
          this.startTime = ended;
          this.startPts = this.pts;
          await this.sleep(frameMs);
        } else {
          const delay = Math.max(0, mediaElapsed - wallElapsed);
          if (delay > 0) await this.sleep(delay);
        }
      }
      callback();
    } catch (error) {
      callback(error);
    } finally {
      packet.free?.();
    }
  }
}

class PersistentTrackFeeder {
  constructor({ streamer, videoModule, width = 1920, height = 1080, frameRate = 30 } = {}) {
    this.streamer = streamer;
    this.videoModule = videoModule;
    this.width = width;
    this.height = height;
    this.frameRate = frameRate;
    this.connection = null;
    this.startPromise = null;
    this.startAbort = null;
    this.closed = false;
    this.active = null;
    // Encoded payload handed to a connected native WebRTC transport. The
    // generic libdatachannel PeerConnection.bytesSent() counter remains zero
    // for RTP media, so it cannot validate Go Live delivery.
    this.rtcBytesSent = 0;
  }

  async start() {
    if (this.connection) return this.connection;
    if (this.closed) throw new Error('Persistent track feeder is closed');
    if (this.startPromise) return this.startPromise;

    // Pipeline initialization and the first append happen concurrently. Both
    // call start(), so latch the handshake or they create competing Discord
    // streams and readiness can be observed on the wrong connection.
    const abort = new AbortController();
    this.startAbort = abort;
    const cancelled = new Promise((_, reject) => {
      abort.signal.addEventListener('abort', () => reject(new Error('Persistent track feeder closed during startup')), { once: true });
    });
    const created = Promise.resolve().then(() => this.streamer.createStream()).then(connection => {
      if (this.closed || abort.signal.aborted) {
        this.streamer.stopStream?.();
        throw new Error('Persistent track feeder closed during startup');
      }
      connection.setPacketizer('H264');
      connection.mediaConnection.setSpeaking(true);
      connection.mediaConnection.setVideoAttributes(true, {
        width: Math.round(this.width), height: Math.round(this.height), fps: Math.round(this.frameRate)
      });
      this.connection = connection;
      return connection;
    });
    const starting = Promise.race([created, cancelled]);
    this.startPromise = starting;
    try {
      return await starting;
    } finally {
      if (this.startPromise === starting) this.startPromise = null;
      if (this.startAbort === abort) this.startAbort = null;
    }
  }

  async append(input, signal, onVideoFrame, { syncVideoToAudio = true } = {}) {
    if (this.closed) throw new Error('Persistent track feeder is closed');
    if (this.active) throw new Error('Concurrent track feeders are not allowed');
    const connection = await this.start();
    signal?.throwIfAborted();
    let active = null;
    const cancel = () => {
      input.destroy();
      active?.videoSource.destroy();
      active?.audioSource.destroy();
      active?.video.destroy();
      active?.audio.destroy();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      // Our normalized NUT header already describes both tracks. Preserve the
      // opening packets instead of discarding them during format probing.
      registerPersistentInput(input);
      const media = await this.videoModule.demux(input, { format: 'nut' });
      signal?.throwIfAborted();
      if (!media.video || !media.audio) throw new Error('Content must contain normalized video and Opus audio');
      const sendVideo = (frame, ms) => {
        if (!connection.ready) return;
        connection.sendVideoFrame(frame, ms);
        this.rtcBytesSent += frame.length;
        onVideoFrame?.(ms);
      };
      const sendAudio = (frame, ms) => {
        if (!connection.ready) return;
        this.rtcBytesSent += frame.length;
        connection.sendAudioFrame(frame, ms);
      };
      const video = new TimedTrack(sendVideo, 'video', { defaultDurationMs: 1000 / this.frameRate });
      const audio = new TimedTrack(sendAudio, 'audio');
      // The demuxer reads one interleaved stream and stops when either output
      // queue fills. On seekable VOD, waiting for an audio packet while the
      // video queue is full can prevent the demuxer from reading that audio.
      // Both tracks still pace their packets from media timestamps.
      if (syncVideoToAudio) video.syncTrack = audio;
      active = { input, video, audio, videoSource: media.video.stream, audioSource: media.audio.stream };
      this.active = active;
      active.videoSource.pipe(video);
      active.audioSource.pipe(audio);
      try {
        await Promise.all([finished(video), finished(audio)]);
      } catch (error) {
        if (!signal?.aborted) {
          cancel();
          throw error;
        }
      }
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (this.active === active) this.active = null;
    }
  }

  interrupt() {
    this.closed = true;
    this.startAbort?.abort();
    const active = this.active;
    active?.input.destroy();
    active?.videoSource.destroy();
    active?.audioSource.destroy();
    active?.video.destroy();
    active?.audio.destroy();
  }

  async close() { this.interrupt(); }
}

module.exports = { PersistentTrackFeeder, TimedTrack };
