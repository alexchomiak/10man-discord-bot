'use strict';

const { Writable } = require('node:stream');
const { finished } = require('node:stream/promises');
const { setTimeout: sleep } = require('node:timers/promises');

// Same timestamp-driven sender used by discord-video-stream, kept here so a
// new normalized input can be attached without calling createStream again.
class TimedTrack extends Writable {
  constructor(send, type) {
    super({ objectMode: true, highWaterMark: 0 });
    this.send = send;
    this.type = type;
    this.pts = undefined;
    this.syncTrack = null;
    this.startTime = undefined;
    this.startPts = undefined;
  }

  async _write(packet, _encoding, callback) {
    try {
      const { data, pts, duration, timeBase } = packet;
      if (!data) return callback();
      const frameMs = Number(duration) * timeBase.num * 1000 / timeBase.den;
      const started = performance.now();
      this.send(Buffer.from(data), frameMs);
      const ended = performance.now();
      this.pts = Number(pts) * timeBase.num * 1000 / timeBase.den;
      this.startTime ??= started;
      this.startPts ??= this.pts;

      const other = this.syncTrack?.pts;
      if (this.type === 'video' && !this.syncTrack?.writableEnded && Number.isFinite(other) && this.pts - other > 20) {
        while (!this.destroyed && !this.syncTrack?.writableEnded &&
          Number.isFinite(this.syncTrack?.pts) && this.pts - this.syncTrack.pts > 20) {
          await sleep(frameMs);
        }
        this.startTime = this.startPts = undefined;
      } else {
        const delay = Math.max(0, this.pts - this.startPts + frameMs - (ended - this.startTime));
        if (delay > 0) await sleep(delay);
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
    this.closed = false;
    this.active = null;
  }

  async start() {
    if (this.connection) return this.connection;
    if (this.closed) throw new Error('Persistent track feeder is closed');
    const connection = await this.streamer.createStream();
    if (this.closed) {
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
  }

  async append(input, signal) {
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
      const media = await this.videoModule.demux(input, { format: 'nut' });
      signal?.throwIfAborted();
      if (!media.video || !media.audio) throw new Error('Content must contain normalized video and Opus audio');
      const video = new TimedTrack((frame, ms) => connection.sendVideoFrame(frame, ms), 'video');
      const audio = new TimedTrack((frame, ms) => connection.sendAudioFrame(frame, ms), 'audio');
      video.syncTrack = audio;
      active = { input, video, audio, videoSource: media.video.stream, audioSource: media.audio.stream };
      this.active = active;
      active.videoSource.pipe(video);
      active.audioSource.pipe(audio);
      const results = await Promise.allSettled([finished(video), finished(audio)]);
      if (!signal?.aborted) {
        const failure = results.find(result => result.status === 'rejected');
        if (failure) throw failure.reason;
      }
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (this.active === active) this.active = null;
    }
  }

  interrupt() {
    this.closed = true;
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
