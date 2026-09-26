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
    return { ok, message, status: this.streamManager.status(),
      progressOverlay: this.streamManager.progressOverlay === true, ...extra };
  }

  // Broker responses cross a JSON boundary. StreamManager results also carry
  // live implementation objects (voice links, FFmpeg processes, streams and
  // timers), so only copy the primitive command facts the app bot needs.
  _detail(result, fields) {
    const detail = {};
    for (const field of fields) {
      const value = result?.[field];
      if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) detail[field] = value;
    }
    return detail;
  }

  async execute(operation, payload = {}) {
    const guildId = payload.guildId || this.config.guildId;
    const channelId = payload.channelId || this.config.streamChannelId;
    switch (operation) {
      case 'ping': return this._result(true, M.PONG);
      case 'toggle-overlay': {
        const r = await this.streamManager.toggleProgressOverlay();
        const state = r.enabled ? 'on' : 'off';
        const note = r.enabled && r.available === false
          ? ' It will appear on a VOD with a known duration.' : '';
        return this._result(r.ok === true, `Progress overlay ${state}.${note}`, {
          detail: this._detail(r, ['enabled', 'available', 'restarted'])
        });
      }
      case 'status': {
        const status = this.streamManager.status();
        return { ok: true, message: status ? M.STREAM_STATUS(status) : M.STREAM_NOTHING, status,
          progressOverlay: this.streamManager.progressOverlay === true };
      }
      case 'reorder': {
        const r = await this.streamManager.reorderQueue(payload.ids);
        return this._result(r.ok === true, r.message || 'Queue reordered.');
      }
      case 'remove-queued': {
        const r = await this.streamManager.removeQueued(payload.queueId);
        return this._result(r.ok === true, r.ok ? `Removed ${r.title} from the queue.` : r.message);
      }
      case 'move': {
        if (!guildId || !channelId) return this._result(false, M.STREAM_NEED_CHANNEL);
        const r = await this.streamManager.moveChannel(guildId, channelId);
        return this._result(r.ok === true, r.ok ? `Moved to voice channel ${channelId}.` : (r.message || M.STREAM_JOIN_FAILED));
      }
      case 'set-global-name': {
        const name = String(payload.name || '').trim();
        if (name.length < 1 || name.length > 32) return this._result(false, 'Display name must be 1–32 characters.');
        if (typeof this.client?.user?.setGlobalName !== 'function') {
          return this._result(false, 'This account cannot change its global display name.');
        }
        try {
          await this.client.user.setGlobalName(name);
          return this._result(true, `Global display name changed to ${name}.`);
        } catch (error) {
          return this._result(false, `Global display name change failed: ${error?.message || 'Discord rejected it.'}`);
        }
      }
      case 'join': {
        if (!guildId || !channelId) return this._result(false, M.STREAM_NEED_CHANNEL);
        const r = await this.streamManager.ensureChannel(guildId, channelId);
        return this._result(r?.ok === true, r?.ok ? (r.fillerStarted ? M.JOINED_FILLER(channelId) : M.JOINED(channelId)) : (r?.message || M.STREAM_JOIN_FAILED), {
          detail: this._detail(r, ['reused', 'fillerStarted'])
        });
      }
      case 'stop':
        await this.streamManager.stop();
        return this._result(true, M.STREAM_STOPPED);
      case 'skip': {
        const r = await this.streamManager.skip();
        const message = !r?.ok ? M.STREAM_START_FAILED : r.noOp ? M.SKIP_NONE : r.fellBackToFiller ? M.SKIP_FILLER : M.SKIP_NEXT(r.skippedTo);
        return this._result(r?.ok === true, message, { detail: this._detail(r, ['noOp', 'skippedTo', 'fellBackToFiller', 'queued']) });
      }
      case 'pause': {
        const r = await this.streamManager.pause();
        return this._result(r?.ok === true, !r?.ok ? M.STREAM_START_FAILED : r.noOp ? M.PAUSE_NEED_CONTENT : M.PAUSED, { detail: this._detail(r, ['noOp', 'positionSec']) });
      }
      case 'resume': {
        const r = await this.streamManager.resume();
        return this._result(r?.ok === true, !r?.ok ? M.STREAM_START_FAILED : r.noOp ? M.RESUME_NEED_CONTENT : M.RESUMED, { detail: this._detail(r, ['noOp', 'positionSec']) });
      }
      case 'catchup': {
        const r = await this.streamManager.catchup();
        const message = !r?.ok ? M.STREAM_START_FAILED : r.noOp ? M.CATCHUP_NEED_CONTENT : r.applied === false ? M.CATCHUP_NOT_LIVE : M.CAUGHTUP;
        return this._result(r?.ok === true, message, { detail: this._detail(r, ['noOp', 'applied', 'newPosSec']) });
      }
      case 'scrub': {
        const deltaSec = Number(payload.deltaSec);
        if (!Number.isFinite(deltaSec) || deltaSec === 0) return this._result(false, M.SCRUB_USAGE);
        const r = await this.streamManager.scrub(deltaSec);
        const message = !r?.ok ? M.STREAM_START_FAILED : r.noOp ? (r.reason === 'live' ? M.SCRUB_LIVE : M.SCRUB_NEED_CONTENT) : M.SCRUB_APPLIED(r.newPosSec);
        return this._result(r?.ok === true, message, { detail: this._detail(r, ['noOp', 'reason', 'newPosSec']) });
      }
      case 'seek': {
        const positionSec = Number(payload.positionSec);
        if (!Number.isFinite(positionSec) || positionSec < 0) return this._result(false, 'Invalid seek position.');
        const r = await this.streamManager.seekTo(positionSec);
        const message = !r?.ok ? M.STREAM_START_FAILED : r.noOp
          ? (r.reason === 'live' ? M.SCRUB_LIVE : M.SCRUB_NEED_CONTENT) : M.SCRUB_APPLIED(r.newPosSec);
        return this._result(r?.ok === true, message, { detail: this._detail(r, ['noOp', 'reason', 'newPosSec']) });
      }
      case 'play': {
        if (!guildId || !channelId) return this._result(false, M.STREAM_NEED_CHANNEL);
        const input = String(payload.source || '').trim();
        if (!input) return this._result(false, M.STREAM_USAGE);
        const resolved = await resolveSource(input, this.config);
        if (!resolved?.available) return this._result(false, resolved?.note || M.SOURCE_UNRECOGNIZED);
        const label = resolved.kind === 'sharetv' && resolved.channel
          ? resolved.channel
          : (resolved.title || resolved.streamUrl || resolved.videoUrl || input);
        const r = await this.streamManager.start({
          guildId, channelId,
          sourceInput: input,
          streamUrl: resolved.streamUrl || null,
          videoUrl: resolved.videoUrl || null,
          audioUrl: resolved.audioUrl || null,
          title: resolved.title || null,
          thumbnail: resolved.thumbnail || null,
          startOffsetSec: resolved.startOffsetSec || null,
          isLive: resolved.isLive === true,
          totalDurationSec: resolved.totalDurationSec ?? null
        });
        const message = !r?.ok ? (r?.message || M.STREAM_START_FAILED) : r.queued ? M.STREAM_QUEUED(label) : r.chained ? M.CHAINED(label) : M.SOURCE_PASSTHROUGH(resolved.kind, label);
        return this._result(r?.ok === true, message, {
          detail: this._detail(r, ['queued', 'chained', 'bufferInserted']),
          source: { kind: resolved.kind, label }
        });
      }
      default: return this._result(false, `Unknown stream operation: ${operation}`);
    }
  }
}

module.exports = { StreamControl };
