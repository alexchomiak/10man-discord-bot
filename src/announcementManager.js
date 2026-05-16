const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { ChannelType, MessageFlags } = require('discord.js');
const { COMMANDS } = require('./commands.ts');
const { DISCORD_MESSAGES } = require('./messages.ts');

const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const MP3_FILE_RE = /^[\w .()\[\]-]+\.mp3$/i;

function parseDurationMs(value, defaultValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
}

function toIso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function parseIsoMs(value) {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function safeMp3FileName(fileName) {
  const clean = String(fileName || '').trim();
  if (!MP3_FILE_RE.test(clean) || path.basename(clean) !== clean) {
    return null;
  }

  return clean;
}

function summarizeError(error) {
  return {
    name: error?.name,
    code: error?.code,
    message: error?.message,
    causeName: error?.cause?.name,
    causeCode: error?.cause?.code,
    causeMessage: error?.cause?.message
  };
}

class AnnouncementManager {
  constructor(config = {}, audioManager = null, draftManager = null) {
    this.config = config;
    this.audioManager = audioManager;
    this.draftManager = draftManager;
    this.dbPath = config.sqlitePath || '/app/data/bot.db';
    this.audioDirectory = config.announcementAudioDirectory || path.dirname(config.lobbyMusicPath || '/app/data/lobby.mp3');
    this.cooldownMs = parseDurationMs(config.announcementCooldownMs || process.env.ANNOUNCEMENT_COOLDOWN_MS, DEFAULT_COOLDOWN_MS);
    this.skipDuringDraft = config.skipAnnouncementsDuringDraft !== false;
    this.db = null;
    this.inFlightByGuild = new Set();
  }

  initDb() {
    if (this.db) {
      return;
    }

    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS announcements (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        last_left_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_announcements_user ON announcements(user_id);
    `);
  }

  isDraftActive(guildId) {
    return this.skipDuringDraft && Boolean(guildId && this.draftManager?.getSessionByGuild(guildId));
  }

  resolveAudioPath(fileName) {
    const safeFileName = safeMp3FileName(fileName);
    if (!safeFileName) {
      return null;
    }

    return path.join(this.audioDirectory, safeFileName);
  }

  getMapping(guildId, userId) {
    this.initDb();
    return this.db.prepare('SELECT * FROM announcements WHERE guild_id = ? AND user_id = ?').get(guildId, userId) || null;
  }

  saveMapping(guildId, userId, fileName) {
    this.initDb();
    const now = toIso();
    this.db.prepare(`
      INSERT INTO announcements (guild_id, user_id, file_name, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        file_name = excluded.file_name,
        updated_at = excluded.updated_at
    `).run(guildId, userId, fileName, now);
    return this.getMapping(guildId, userId);
  }

  updateLastLeft(guildId, userId, when = Date.now()) {
    this.initDb();
    this.db.prepare(`
      UPDATE announcements
      SET last_left_at = ?, updated_at = ?
      WHERE guild_id = ? AND user_id = ?
    `).run(toIso(when), toIso(when), guildId, userId);
  }

  resetLastLeft(guildId, userId) {
    this.initDb();
    const now = toIso();
    const result = this.db.prepare(`
      UPDATE announcements
      SET last_left_at = NULL, updated_at = ?
      WHERE guild_id = ? AND user_id = ?
    `).run(now, guildId, userId);
    return result.changes > 0;
  }

  removeMapping(guildId, userId) {
    this.initDb();
    const result = this.db.prepare(`
      DELETE FROM announcements
      WHERE guild_id = ? AND user_id = ?
    `).run(guildId, userId);
    return result.changes > 0;
  }

  async handleAnnounceCommand(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: DISCORD_MESSAGES.SERVER_ONLY, flags: MessageFlags.Ephemeral });
      return;
    }

    const user = interaction.options.getUser(COMMANDS.ANNOUNCE.options.ALIAS.name, true);
    const requestedFileName = interaction.options.getString(COMMANDS.ANNOUNCE.options.FILENAME.name, true);
    const fileName = safeMp3FileName(requestedFileName);
    if (!fileName) {
      await interaction.reply({
        content: DISCORD_MESSAGES.announcementInvalidFilename,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const audioPath = this.resolveAudioPath(fileName);
    if (!audioPath || !fs.existsSync(audioPath)) {
      await interaction.reply({
        content: DISCORD_MESSAGES.announcementFileMissing(fileName, this.audioDirectory),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    this.saveMapping(interaction.guildId, user.id, fileName);
    await interaction.reply({
      content: DISCORD_MESSAGES.announcementSaved(user, fileName),
      flags: MessageFlags.Ephemeral
    });
  }

  async handleResetAnnounceTimerCommand(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: DISCORD_MESSAGES.SERVER_ONLY, flags: MessageFlags.Ephemeral });
      return;
    }

    const user = interaction.options.getUser(COMMANDS.RESET_ANNOUNCE_TIMER.options.ALIAS.name, true);
    const reset = this.resetLastLeft(interaction.guildId, user.id);
    await interaction.reply({
      content: reset
        ? DISCORD_MESSAGES.announcementCooldownReset(user)
        : DISCORD_MESSAGES.announcementMappingMissing(user, COMMANDS.ANNOUNCE.name),
      flags: MessageFlags.Ephemeral
    });
  }

  async handleRemoveAnnouncementCommand(interaction) {
    if (!interaction.guildId) {
      await interaction.reply({ content: DISCORD_MESSAGES.SERVER_ONLY, flags: MessageFlags.Ephemeral });
      return;
    }

    const user = interaction.options.getUser(COMMANDS.REMOVE_ANNOUNCEMENT.options.ALIAS.name, true);
    const removed = this.removeMapping(interaction.guildId, user.id);
    await interaction.reply({
      content: removed
        ? DISCORD_MESSAGES.announcementRemoved(user)
        : DISCORD_MESSAGES.announcementMappingMissing(user, COMMANDS.ANNOUNCE.name),
      flags: MessageFlags.Ephemeral
    });
  }

  shouldAnnounce(mapping, now = Date.now()) {
    const lastLeftMs = parseIsoMs(mapping?.last_left_at);
    if (!lastLeftMs) {
      return { allowed: true, reason: 'no_previous_leave' };
    }

    const elapsedMs = now - lastLeftMs;
    if (elapsedMs < this.cooldownMs) {
      return { allowed: false, reason: 'cooldown', remainingMs: this.cooldownMs - elapsedMs };
    }

    return { allowed: true, reason: 'cooldown_elapsed' };
  }

  async handleVoiceStateUpdate(oldState, newState) {
    const guildId = newState.guild?.id || oldState.guild?.id;
    const member = newState.member || oldState.member;
    if (!guildId || !member || member.user?.bot) {
      return;
    }

    const oldChannelId = oldState.channelId || null;
    const newChannelId = newState.channelId || null;

    if (oldChannelId && !newChannelId) {
      this.updateLastLeft(guildId, member.id);
      return;
    }

    if (!oldChannelId && newChannelId) {
      await this.handleVoiceJoin(newState);
    }
  }

  async handleVoiceJoin(newState) {
    const guildId = newState.guild.id;
    const member = newState.member;
    const voiceChannel = newState.channel;
    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
      return;
    }

    if (this.isDraftActive(guildId)) {
      return;
    }

    // First eligible join wins: do not queue announcements or interrupt active audio.
    if (this.inFlightByGuild.has(guildId) || this.audioManager?.hasActivePlayback(guildId)) {
      return;
    }

    const mapping = this.getMapping(guildId, member.id);
    if (!mapping) {
      return;
    }

    const decision = this.shouldAnnounce(mapping);
    if (!decision.allowed) {
      return;
    }

    const audioPath = this.resolveAudioPath(mapping.file_name);
    if (!audioPath || !fs.existsSync(audioPath)) {
      console.warn('[announcements] announcement file missing', { guildId, userId: member.id, fileName: mapping.file_name, audioPath });
      return;
    }

    this.inFlightByGuild.add(guildId);
    try {
      if (this.isDraftActive(guildId)) {
        return;
      }

      await this.audioManager.join(voiceChannel, { startMusic: false });
      if (this.isDraftActive(guildId) || this.audioManager.hasActivePlayback(guildId)) {
        return;
      }

      await this.audioManager.playFilePathOnce(guildId, audioPath);
    } catch (error) {
      console.error('[announcements] failed to play announcement:', summarizeError(error));
    } finally {
      this.inFlightByGuild.delete(guildId);
      if (!this.isDraftActive(guildId)) {
        this.audioManager.stop(guildId);
      }
    }
  }
}

module.exports = {
  AnnouncementManager,
  safeMp3FileName
};
