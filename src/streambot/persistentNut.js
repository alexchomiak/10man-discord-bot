'use strict';

const { PassThrough } = require('node:stream');

// One muxer/container header for the lifetime of a voice link. Each producer
// has its own demuxer; independent NUT containers are NEVER byte-concatenated.
class PersistentNut {
  constructor({ output = new PassThrough(), loadAv = () => import('node-av'), frameRate = 30 } = {}) {
    this.output = output;
    this.frameRate = frameRate;
    this.loadAv = loadAv;
    this.endUs = 0n;
    this.closed = false;
    this.busy = false;
    this.muxer = null;
    this.profile = null;
  }

  async _write(buffer) {
    if (this.closed || this.output.destroyed) throw new Error('Persistent output closed');
    // libav reuses its memory after this callback returns.
    const copy = Buffer.from(buffer);
    if (!this.output.write(copy)) {
      await new Promise((resolve, reject) => {
        const clear = () => {
          this.output.off('drain', drain);
          this.output.off('close', close);
          this.output.off('error', close);
        };
        const drain = () => { clear(); resolve(); };
        const close = () => { clear(); reject(new Error('Persistent output closed')); };
        this.output.once('drain', drain);
        this.output.once('close', close);
        this.output.once('error', close);
      });
    }
    return copy.length;
  }

  async append(input, signal) {
    if (this.closed) throw new Error('Persistent output closed');
    if (this.busy) throw new Error('Concurrent NUT writers are not allowed');
    this.busy = true;
    let demuxer;
    const cancel = () => input.destroy(); // wake a pending native read safely
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      signal?.throwIfAborted();
      const { Demuxer, Muxer, AV_NOPTS_VALUE } = await this.loadAv();
      signal?.throwIfAborted();
      demuxer = await Demuxer.open(input, { format: 'nut', skipStreamInfo: true });
      signal?.throwIfAborted();
      const streams = [demuxer.video(), demuxer.audio()];
      if (streams.some(s => !s)) throw new Error('Content must contain normalized video and Opus audio');
      const profile = streams.map(s => {
        const c = s.codecpar;
        return [c.codecId, c.width, c.height, c.sampleRate, c.channels];
      });
      if (this.profile && JSON.stringify(profile) !== JSON.stringify(this.profile)) {
        throw new Error('Content codec parameters changed within the persistent session');
      }
      if (!this.muxer) {
        this.profile = profile;
        this.muxer = await Muxer.open({ write: buffer => this._write(buffer) }, {
          format: 'nut', useAsyncWrite: false, useSyncQueue: false,
          exitOnError: true, options: { flush_packets: '1' }
        });
        this.indices = streams.map(s => this.muxer.addStream(s));
      }
      let baseUs = this.endUs;
      let originUs;
      for await (const packet of demuxer.packets()) {
        if (!packet) continue;
        try {
          signal?.throwIfAborted();
          if (this.closed) break;
          const index = streams.findIndex(s => s.index === packet.streamIndex);
          if (index < 0) continue; // discard the producer's extra silent track
          const { num, den } = packet.timeBase;
          const numerator = BigInt(num) * 1000000n;
          const denominator = BigInt(den);
          // All producers use -bf 0, so an absent DTS is the presentation time.
          if (packet.dts === AV_NOPTS_VALUE) packet.dts = packet.pts;
          if (packet.pts === AV_NOPTS_VALUE) packet.pts = packet.dts;
          if (packet.pts === AV_NOPTS_VALUE) {
            throw new Error('Content packet has no timestamp');
          }
          // One shared A/V offset preserves lip sync and handles nonzero starts.
          if (originUs === undefined) {
            const now = process.hrtime.bigint();
            this.startedAt ??= now;
            const wallUs = (now - this.startedAt) / 1000n;
            if (wallUs > baseUs) baseUs = wallUs;
            originUs = packet.dts * numerator / denominator;
          }
          const offset = (baseUs - originUs) * denominator / numerator;
          packet.pts += offset;
          packet.dts += offset;
          if (!packet.duration && index === 0) {
            packet.duration = BigInt(Math.round(den / (num * this.frameRate)));
          }
          // Opus in NUT sometimes reports duration=0; derive it from its TOC.
          if (!packet.duration && index === 1) {
            const toc = packet.data[0];
            const frames = (toc & 3) === 0 ? 1 : (toc & 3) === 3 ? packet.data[1] & 63 : 2;
            const durations = [10,20,40,60,10,20,40,60,10,20,40,60,10,20,10,20,2.5,5,10,20,2.5,5,10,20,2.5,5,10,20,2.5,5,10,20];
            packet.duration = BigInt(Math.round(durations[toc >> 3] * frames * den / (1000 * num)));
          }
          const end = (packet.pts + packet.duration) * numerator / denominator;
          if (end > this.endUs) this.endUs = end;
          await this.muxer.writePacket(packet, this.indices[index]);
        } finally { packet.free(); }
      }
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (demuxer) await demuxer.close();
      this.busy = false;
    }
  }

  // Interrupt output backpressure first; append() must settle before freeing
  // the muxer's native context. The owner awaits its writer before close().
  interrupt() {
    this.closed = true;
    this.output.destroy();
  }

  async close() {
    this.closed = true;
    if (this.muxer) await this.muxer.close();
    this.output.destroy();
  }
}

module.exports = { PersistentNut };
