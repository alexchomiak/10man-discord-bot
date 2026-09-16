'use strict';

const { M } = require('./messages');
const { TAG, redactToken } = require('./config');
const { resolveSource, parseSignedDuration } = require('./sources');
const { createAlertSink } = require('./alerts');

function log(...parts) {
  console.log(TAG, ...parts);
}

class CommandRegistry {
  constructor({ client, streamManager }) {
    this.client = client;
    this.streamManager = streamManager;
    this.commands = new Map();
    this.register('ping', this.cmdPing.bind(this));
    this.register('stream', this.cmdStream.bind(this));
    this.register('join', this.cmdJoin.bind(this));
    this.register('stop', this.cmdStop.bind(this));
    this.register('status', this.cmdStatus.bind(this));
    this.register('skip', this.cmdSkip.bind(this));
    this.register('scrub', this.cmdScrub.bind(this));
    this.register('pause', this.cmdPause.bind(this));
    this.register('resume', this.cmdResume.bind(this));
    this.register('catchup', this.cmdCatchup.bind(this));
  }

  register(name, handler) {
    const key = String(name).toLowerCase();
    if (this.commands.has(key)) throw new Error(`Duplicate command: ${key}`);
    this.commands.set(key, handler);
  }

  has(name) {
    return this.commands.has(String(name).toLowerCase());
  }

  async dispatch(message, argString) {
    const parts = String(argString || '').split(/\s+/).filter(Boolean);
    const commandToken = (parts[0] || '').toLowerCase();
    const separator = commandToken.indexOf(':');
    const name = separator === -1 ? commandToken : commandToken.slice(0, separator);
    const requestedWorkerId = separator === -1 ? null : commandToken.slice(separator + 1);
    const args = parts.slice(1);
    if (!name || !this.has(name)) return;
    if (separator !== -1 && (!requestedWorkerId || !/^[a-z0-9_-]{1,32}$/.test(requestedWorkerId))) return;
    const config = this.streamManager?.config || {};
    const workerId = String(config.workerId || 'primary').toLowerCase();
    const defaultWorkerId = String(config.defaultWorkerId || 'primary').toLowerCase();
    const targetWorkerId = requestedWorkerId || defaultWorkerId;
    if (workerId !== targetWorkerId) return;
    const allowedUserIds = this.streamManager?.config?.allowedUserIds;
    if (Array.isArray(allowedUserIds) && allowedUserIds.length > 0) {
      const authorId = message?.author?.id == null ? '' : String(message.author.id);
      if (!allowedUserIds.includes(authorId)) return;
    }
    const handler = this.commands.get(name);
    try {
      await handler(message, args);
    } catch (err) {
      const msg = (err && err.message) || M.STREAM_START_FAILED;
      void this.reply(message, msg);
    }
  }

  // The bot account is restricted and can NO LONGER send channel messages:
  // this helper must never call message.reply / channel.send. All feedback is
  // logged locally (redacted) and, when TELEMETRY_WEBHOOK_URL is configured,
  // POSTed to the outbound alert webhook (see alerts.js). Fire-and-forget —
  // the webhook must neither throw nor block command dispatch.
  async reply(message, text) {
    const cfg = (this.streamManager && this.streamManager.config) || {};
    const token = cfg.token || (this.client && this.client.token) || '';
    const redacted = redactToken(String(text || ''), token);
    log('info', `(no-send) ${redacted}`);
    try {
      void this.alertSink().notify('cmd', redacted).catch(() => {});
    } catch { /* the sink must never throw (alerts.js guarantees this) */ }
  }

  alertSink() {
    if (!this._alertSink) {
      const cfg = (this.streamManager && this.streamManager.config) || {};
      if (cfg && typeof (cfg.alertSink || {}).notify === 'function') {
        // Ready-made sink object (test seam); same notify(event, detail) shape.
        this._alertSink = cfg.alertSink;
      } else {
        this._alertSink = createAlertSink({
          url: cfg.alertWebhookUrl || null,
          log: (level, ...parts) => {
            if (level === 'warn') console.warn(TAG, ...parts);
            else console.log(TAG, ...parts);
          }
        });
      }
    }
    return this._alertSink;
  }

  statusText() {
    const s = this.streamManager.status();
    if (!s) return M.STREAM_NOTHING;
    return M.STREAM_STATUS(s);
  }

  resolveVoiceChannelId(message) {
    const memberChannel =
      message && message.member && message.member.voice ? message.member.voice.channelId : null;
    return memberChannel || this.streamManager.defaultChannelId || null;
  }

  resolveGuildId(message) {
    return (
      (message && message.guild ? message.guild.id : null) ||
      (this.streamManager.config && this.streamManager.config.guildId) ||
      null
    );
  }

  async cmdPing(message) {
    await this.reply(message, M.PONG);
  }

  // $join: open (or stay in) the voice channel WITHOUT starting a video, so
  // viewers can connect early. Idempotent — calling it while already in the
  // channel renews the grace window and does NOT re-join (no kick/re-join and
  // no missed first seconds when the stream later starts).
  async cmdJoin(message) {
    const channelId = this.resolveVoiceChannelId(message);
    if (!channelId) {
      await this.reply(message, M.STREAM_NEED_CHANNEL);
      return;
    }
    const guildId = this.resolveGuildId(message);
    if (!guildId) {
      await this.reply(message, M.JOIN_NO_GUILD);
      return;
    }
    const result = await this.streamManager.ensureChannel(guildId, channelId);
    if (!result || result.ok !== true) {
      await this.reply(message, (result && result.message) || M.STREAM_JOIN_FAILED);
      return;
    }
    // A local placeholder (filler) was just started: the go-live handshake is
    // already pre-warmed on the live voice connection. A later `stream <url>`
    // swaps the real feed in over the SAME connection (no re-join). A real
    // stream (or an existing placeholder) that was already attached is left
    // untouched, so a re-join here never clobbers it.
    if (result.fillerStarted) {
      await this.reply(message, M.JOINED_FILLER(channelId));
      return;
    }
    await this.reply(message, M.JOINED(channelId));
  }

  async cmdStop(message) {
    await this.streamManager.stop();
    await this.reply(message, M.STREAM_STOPPED);
  }

  async cmdStatus(message) {
    await this.reply(message, this.statusText());
  }

  // $skip: cancel the active piece and advance to the next queued item. The
  // between-stream buffer (a separate filler piece) becomes the playback
  // target, then the next real — the "in-between" gap. If the queue goes
  // empty the manager falls back to the join filler so the channel stays live.
  async cmdSkip(message) {
    const r = await this.streamManager.skip();
    if (!r || r.ok !== true) {
      await this.reply(message, M.STREAM_START_FAILED);
      return;
    }
    if (r.noOp) {
      await this.reply(message, M.SKIP_NONE);
      return;
    }
    if (r.fellBackToFiller) {
      await this.reply(message, M.SKIP_FILLER);
      return;
    }
    await this.reply(message, M.SKIP_NEXT(r.skippedTo));
  }

  // $scrub <signed duration>: advance/rewind a seekable (VOD) piece.
  // Usage: scrub +10m | scrub -90s | scrub +1h30m | scrub +120 (seconds).
  async cmdScrub(message, args) {
    const deltaSec = parseSignedDuration(args[0]);
    if (deltaSec === null) {
      await this.reply(message, M.SCRUB_USAGE);
      return;
    }
    const r = await this.streamManager.scrub(deltaSec);
    if (!r || r.ok !== true) {
      await this.reply(message, M.STREAM_START_FAILED);
      return;
    }
    if (r.noOp) {
      await this.reply(message, r.reason === 'live' ? M.SCRUB_LIVE : M.SCRUB_NEED_CONTENT);
      return;
    }
    await this.reply(message, M.SCRUB_APPLIED(r.newPosSec));
  }

  // $pause: best-effort freeze — stop feeding the muxer, hold the queue, keep
  // the go-live session + muxer open. $resume continues.
  async cmdPause(message) {
    const r = await this.streamManager.pause();
    if (!r || r.ok !== true) {
      await this.reply(message, M.STREAM_START_FAILED);
      return;
    }
    if (r.noOp) {
      await this.reply(message, M.PAUSE_NEED_CONTENT);
      return;
    }
    await this.reply(message, M.PAUSED);
  }

  async cmdResume(message) {
    const r = await this.streamManager.resume();
    if (!r || r.ok !== true) {
      await this.reply(message, M.STREAM_START_FAILED);
      return;
    }
    if (r.noOp) {
      await this.reply(message, M.RESUME_NEED_CONTENT);
      return;
    }
    await this.reply(message, M.RESUMED);
  }

  // $catchup: jump a live stream back to the live head.
  async cmdCatchup(message) {
    const r = await this.streamManager.catchup();
    if (!r || r.ok !== true) {
      await this.reply(message, M.STREAM_START_FAILED);
      return;
    }
    if (r.noOp) {
      await this.reply(message, M.CATCHUP_NEED_CONTENT);
      return;
    }
    if (r.applied === false) {
      await this.reply(message, M.CATCHUP_NOT_LIVE);
      return;
    }
    await this.reply(message, M.CAUGHTUP);
  }

  async cmdStream(message, args) {
    const first = (args[0] || '').trim().toLowerCase();
    if (first === 'stop') return this.cmdStop(message);
    if (first === 'status') return this.cmdStatus(message);

    const raw = args.join(' ').trim();
    if (!raw) {
      await this.reply(message, M.STREAM_USAGE);
      return;
    }

    // Validate targeting BEFORE resolveSource: a missing channel must not
    // trigger a (potentially slow) yt-dlp resolve.
    const channelId = this.resolveVoiceChannelId(message);
    if (!channelId) {
      await this.reply(message, M.STREAM_NEED_CHANNEL);
      return;
    }
    const guildId = this.resolveGuildId(message);

    const config = (this.streamManager && this.streamManager.config) || {};
    let resolved;
    try {
      resolved = await resolveSource(raw, config);
    } catch (err) {
      log('error', 'resolveSource failed:', (err && err.message) || err);
      await this.reply(message, M.SOURCE_UNRECOGNIZED);
      return;
    }

    if (!resolved || resolved.available !== true) {
      log(`source ${resolved && resolved.kind}: unavailable`);
      await this.reply(message, (resolved && resolved.note) || M.SOURCE_UNRECOGNIZED);
      return;
    }

    const label =
      resolved.kind === 'sharetv' && resolved.channel
        ? resolved.channel
        : (resolved.streamUrl || resolved.videoUrl || raw);
    log(`source ${resolved.kind} resolved -> ${label}`);

    const result = await this.streamManager.start({
      guildId,
      channelId,
      streamUrl: resolved.streamUrl || null,
      videoUrl: resolved.videoUrl || null,
      audioUrl: resolved.audioUrl || null,
      title: resolved.title || null,
      startOffsetSec: resolved.startOffsetSec || null,
      isLive: resolved.isLive === true,
      totalDurationSec: resolved.totalDurationSec != null ? resolved.totalDurationSec : null
    });
    if (!result.ok) {
      await this.reply(message, result.message || M.STREAM_START_FAILED);
      return;
    }
    // A chained start (we were ALREADY in this voice channel) announces that
    // the connection was reused — no re-join, no viewer kick.
    if (result.queued) {
      await this.reply(message, M.STREAM_QUEUED(label));
      return;
    }
    if (result.chained) {
      await this.reply(message, M.CHAINED(label));
      return;
    }
    await this.reply(message, M.SOURCE_PASSTHROUGH(resolved.kind, label));
  }
}

module.exports = { CommandRegistry };
