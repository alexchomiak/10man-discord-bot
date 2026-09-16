'use strict';

const { resolveSource } = require('./sources');
const { M } = require('./messages');

class StreamControl {
  constructor({ streamManager, config, client }) {
    this.streamManager = streamManager;
    this.config = config || {};
    this.client = client;
  }

  _result(ok, message, extra = {}) {
    return { ok, message, status: this.streamManager.status(), ...extra };
  }

  async execute(operation, payload = {}) {
    const guildId = payload.guildId || this.config.guildId;
    const channelId = payload.channelId || this.config.streamChannelId;
    switch (operation) {
      case 'ping': return this._result(true, M.PONG);
      case 'setDisplayName': {
        const name = String(payload.name || '').trim();
        if (name.length < 1 || name.length > 32) {
          return this._result(false, 'Display name must be between 1 and 32 characters.');
        }
        if (!this.client?.user || typeof this.client.user.setGlobalName !== 'function') {
          return this._result(false, 'This streambot cannot update its global display name.');
        }
        await this.client.user.setGlobalName(name);
        return this._result(true, `Display name changed to ${name}.`, { displayName: name });
      }
      case 'status': {
        const status = this.streamManager.status();
        return { ok: true, message: status ? M.STREAM_STATUS(status) : M.STREAM_NOTHING, status };
      }
      case 'join': {
        if (!guildId || !channelId) return this._result(false, M.STREAM_NEED_CHANNEL);
        const r = await this.streamManager.ensureChannel(guildId, channelId);
        return this._result(r?.ok === true, r?.ok ? (r.fillerStarted ? M.JOINED_FILLER(channelId) : M.JOINED(channelId)) : (r?.message || M.STREAM_JOIN_FAILED), { detail: r });
      }
      case 'stop':
        await this.streamManager.stop();
        return this._result(true, M.STREAM_STOPPED);
      case 'skip': {
        const r = await this.streamManager.skip();
        const message = !r?.ok ? M.STREAM_START_FAILED : r.noOp ? M.SKIP_NONE : r.fellBackToFiller ? M.SKIP_FILLER : M.SKIP_NEXT(r.skippedTo);
        return this._result(r?.ok === true, message, { detail: r });
      }
      case 'pause': {
        const r = await this.streamManager.pause();
        return this._result(r?.ok === true, !r?.ok ? M.STREAM_START_FAILED : r.noOp ? M.PAUSE_NEED_CONTENT : M.PAUSED, { detail: r });
      }
      case 'resume': {
        const r = await this.streamManager.resume();
        return this._result(r?.ok === true, !r?.ok ? M.STREAM_START_FAILED : r.noOp ? M.RESUME_NEED_CONTENT : M.RESUMED, { detail: r });
      }
      case 'catchup': {
        const r = await this.streamManager.catchup();
        const message = !r?.ok ? M.STREAM_START_FAILED : r.noOp ? M.CATCHUP_NEED_CONTENT : r.applied === false ? M.CATCHUP_NOT_LIVE : M.CAUGHTUP;
        return this._result(r?.ok === true, message, { detail: r });
      }
      case 'scrub': {
        const deltaSec = Number(payload.deltaSec);
        if (!Number.isFinite(deltaSec) || deltaSec === 0) return this._result(false, M.SCRUB_USAGE);
        const r = await this.streamManager.scrub(deltaSec);
        const message = !r?.ok ? M.STREAM_START_FAILED : r.noOp ? (r.reason === 'live' ? M.SCRUB_LIVE : M.SCRUB_NEED_CONTENT) : M.SCRUB_APPLIED(r.newPosSec);
        return this._result(r?.ok === true, message, { detail: r });
      }
      case 'play': {
        if (!guildId || !channelId) return this._result(false, M.STREAM_NEED_CHANNEL);
        const input = String(payload.source || '').trim();
        if (!input) return this._result(false, M.STREAM_USAGE);
        const resolved = await resolveSource(input, this.config);
        if (!resolved?.available) return this._result(false, resolved?.note || M.SOURCE_UNRECOGNIZED);
        const label = resolved.kind === 'sharetv' && resolved.channel
          ? resolved.channel
          : (resolved.streamUrl || resolved.videoUrl || input);
        const r = await this.streamManager.start({
          guildId, channelId,
          streamUrl: resolved.streamUrl || null,
          videoUrl: resolved.videoUrl || null,
          audioUrl: resolved.audioUrl || null,
          title: resolved.title || null,
          startOffsetSec: resolved.startOffsetSec || null,
          isLive: resolved.isLive === true,
          totalDurationSec: resolved.totalDurationSec ?? null
        });
        const message = !r?.ok ? (r?.message || M.STREAM_START_FAILED) : r.queued ? M.STREAM_QUEUED(label) : r.chained ? M.CHAINED(label) : M.SOURCE_PASSTHROUGH(resolved.kind, label);
        return this._result(r?.ok === true, message, { detail: r, source: { kind: resolved.kind, label } });
      }
      default: return this._result(false, `Unknown stream operation: ${operation}`);
    }
  }
}

module.exports = { StreamControl };
