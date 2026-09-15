'use strict';

const { M } = require('./messages');
const { TAG } = require('./config');
const { resolveSource } = require('./sources');

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
    this.register('stop', this.cmdStop.bind(this));
    this.register('status', this.cmdStatus.bind(this));
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
    const name = (parts[0] || '').toLowerCase();
    const args = parts.slice(1);
    if (!name || !this.has(name)) return;
    const handler = this.commands.get(name);
    try {
      await handler(message, args);
    } catch (err) {
      const msg = (err && err.message) || M.STREAM_START_FAILED;
      void this.reply(message, msg);
    }
  }

  async reply(message, text) {
    try {
      if (message && message.reply) return await message.reply(text);
    } catch (e) {
      /* fall through */
    }
    try {
      if (message && message.channel && message.channel.send) return await message.channel.send(text);
    } catch (e) {
      /* noop */
    }
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

  async cmdStop(message) {
    this.streamManager.stop();
    await this.reply(message, M.STREAM_STOPPED);
  }

  async cmdStatus(message) {
    await this.reply(message, this.statusText());
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
    // trigger a potentially long yt-dlp download.
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
        : (resolved.streamUrl || raw);
    log(`source ${resolved.kind} resolved -> ${label}`);

    const result = await this.streamManager.start({
      guildId,
      channelId,
      streamUrl: resolved.streamUrl,
      title: resolved.title || null,
      localDir: resolved.localDir || null
    });
    if (!result.ok) {
      await this.reply(message, result.message || M.STREAM_START_FAILED);
      return;
    }
    await this.reply(message, M.SOURCE_PASSTHROUGH(resolved.kind, label));
  }
}

module.exports = { CommandRegistry };
