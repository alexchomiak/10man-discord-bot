const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const { DEFAULT_TIMEZONE, parseDailyTime } = require('./schedulerManager');

const TARGET_TIMEZONE = DEFAULT_TIMEZONE;

class NotificationManager {
  constructor(client, config) {
    this.client = client;
    this.config = config;
    this.state = {
      messageId: null,
      messageDateKey: null,
      interested: new Set()
    };
    const notificationTime = parseDailyTime(this.config.notificationTimeCst || '18:00');
    this.targetHour = notificationTime.hour;
    this.targetMinute = notificationTime.minute;
    this.targetTimeLabel = notificationTime.label;
    this.dbPath = this.config.sqlitePath || '/app/data/bot.db';
    this.db = null;
  }

  isEnabled() {
    return Boolean(this.config.notificationChannelId && this.config.notificationRoleId);
  }

  async initialize() {
    if (!this.isEnabled()) {
      return { enabled: false, reason: 'notification channel or role is not configured' };
    }

    this.initDb();
    this.loadStateFromDb();

    const channel = await this.client.channels.fetch(this.config.notificationChannelId).catch(() => null);
    const hasPersistedMessage = await this.ensurePersistedMessageExists(channel);
    if (!hasPersistedMessage) {
      this.resetState();
      this.clearStateInDb();
    }

    const nowParts = this.getChicagoParts(new Date());
    const todayKey = `${nowParts.year}-${String(nowParts.month).padStart(2, '0')}-${String(nowParts.day).padStart(2, '0')}`;
    if (
      nowParts.hour > this.targetHour
      || (nowParts.hour === this.targetHour && nowParts.minute >= this.targetMinute)
    ) {
      if (this.state.messageDateKey !== todayKey) {
        await this.postDailyPrompt(channel);
      }
    }

    return {
      enabled: true,
      messageDateKey: this.state.messageDateKey || 'none',
      targetTime: this.targetTimeLabel
    };
  }

  buildButtons() {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('cs2_interest')
        .setLabel('Interested')
        .setEmoji('👍')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('cs2_not_interest')
        .setLabel('Not Interested')
        .setEmoji('👎')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('cs2_subscribe')
        .setLabel('Subscribe')
        .setEmoji('🔔')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('cs2_unsubscribe')
        .setLabel('Unsubscribe')
        .setEmoji('🔕')
        .setStyle(ButtonStyle.Danger)
    );
  }

  getChicagoDateKey(date) {
    const parts = this.getChicagoParts(date);
    return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
  }

  initDb() {
    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notification_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        message_id TEXT,
        message_date_key TEXT
      );

      CREATE TABLE IF NOT EXISTS notification_interested (
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY (message_id, user_id)
      );
    `);
  }

  resetState() {
    this.state.messageId = null;
    this.state.messageDateKey = null;
    this.state.interested.clear();
  }

  loadStateFromDb() {
    const stateRow = this.db.prepare('SELECT message_id, message_date_key FROM notification_state WHERE singleton = 1').get();
    if (!stateRow || !stateRow.message_id) {
      this.resetState();
      return;
    }

    this.state.messageId = stateRow.message_id;
    this.state.messageDateKey = stateRow.message_date_key;
    const interestedRows = this.db.prepare('SELECT user_id FROM notification_interested WHERE message_id = ?').all(this.state.messageId);
    this.state.interested = new Set(interestedRows.map((row) => row.user_id));
  }

  saveStateToDb() {
    this.db.prepare(`
      INSERT INTO notification_state (singleton, message_id, message_date_key)
      VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        message_id = excluded.message_id,
        message_date_key = excluded.message_date_key
    `).run(this.state.messageId, this.state.messageDateKey);
  }

  clearStateInDb() {
    this.db.prepare('DELETE FROM notification_interested').run();
    this.db.prepare('DELETE FROM notification_state WHERE singleton = 1').run();
  }

  addInterestedInDb(userId) {
    if (!this.state.messageId) {
      return;
    }
    this.db.prepare('INSERT OR IGNORE INTO notification_interested (message_id, user_id) VALUES (?, ?)').run(this.state.messageId, userId);
  }

  removeInterestedInDb(userId) {
    if (!this.state.messageId) {
      return;
    }
    this.db.prepare('DELETE FROM notification_interested WHERE message_id = ? AND user_id = ?').run(this.state.messageId, userId);
  }

  async ensurePersistedMessageExists(channel) {
    if (!this.state.messageId || !channel || !('messages' in channel)) {
      return false;
    }
    const existing = await channel.messages.fetch(this.state.messageId).catch(() => null);
    return Boolean(existing);
  }

  async deletePreviousMessage(channel) {
    if (!this.state.messageId) {
      return;
    }
    const oldMessage = await channel.messages.fetch(this.state.messageId).catch(() => null);
    if (oldMessage) {
      await oldMessage.delete().catch(() => {});
    }
  }

  async formatInterestedTable(guild) {
    if (this.state.interested.size === 0) {
      return 'No one has clicked Interested yet.';
    }

    const users = await Promise.all(
      [...this.state.interested].map(async (id) => {
        const cached = guild.members.cache.get(id);
        if (cached) {
          return { id, displayName: cached.displayName };
        }
        const fetched = await guild.members.fetch(id).catch(() => null);
        return { id, displayName: fetched?.displayName || id };
      })
    );

    const lines = [];
    users.forEach((user, idx) => {
      lines.push(`${idx + 1}. <@${user.id}> (${user.displayName})`);
    });
    return lines.join('\n');
  }

  async buildEmbed(guild) {
    return new EmbedBuilder()
      .setTitle('CS2 Daily Queue')
      .setDescription([
        'Click the Interested Button if interested in playing CS2 today',
        '',
        '*You can Subscribe/Unsubscribe from notifications by clicking the buttons below.*'
      ].join('\n'))
      .addFields({ name: 'Interested Players', value: await this.formatInterestedTable(guild) });
  }

  async postDailyPrompt(existingChannel = null) {
    const channel = existingChannel || await this.client.channels.fetch(this.config.notificationChannelId).catch(() => null);
    if (!channel || !('send' in channel) || !('messages' in channel)) {
      return;
    }

    await this.deletePreviousMessage(channel);

    this.resetState();
    this.clearStateInDb();

    const message = await channel.send({
      content: `<@&${this.config.notificationRoleId}>`,
      embeds: [await this.buildEmbed(channel.guild)],
      components: [this.buildButtons()]
    });

    this.state.messageId = message.id;
    this.state.messageDateKey = this.getChicagoDateKey(new Date());
    this.saveStateToDb();
  }

  async handleButton(interaction) {
    if (!this.isEnabled()) {
      return;
    }

    if (interaction.message.id !== this.state.messageId) {
      await interaction.reply({ content: 'This notification is no longer active.', flags: MessageFlags.Ephemeral });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: 'This action must be used in a server.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.customId === 'cs2_interest') {
      this.state.interested.add(interaction.user.id);
      this.addInterestedInDb(interaction.user.id);

      const member = await guild.members.fetch(interaction.user.id).catch(() => null);
      const role = guild.roles.cache.get(this.config.notificationRoleId)
        || await guild.roles.fetch(this.config.notificationRoleId).catch(() => null);
      if (member && role && !member.roles.cache.has(role.id)) {
        await member.roles.add(role).catch(() => {});
      }

      await interaction.update({ embeds: [await this.buildEmbed(guild)], components: [this.buildButtons()] });
      return;
    }

    if (interaction.customId === 'cs2_not_interest') {
      this.state.interested.delete(interaction.user.id);
      this.removeInterestedInDb(interaction.user.id);
      await interaction.update({ embeds: [await this.buildEmbed(guild)], components: [this.buildButtons()] });
      return;
    }

    const member = await guild.members.fetch(interaction.user.id);
    const role = guild.roles.cache.get(this.config.notificationRoleId)
      || await guild.roles.fetch(this.config.notificationRoleId).catch(() => null);

    if (!role) {
      await interaction.reply({ content: 'Notification role is missing.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.customId === 'cs2_subscribe') {
      await member.roles.add(role);
      await interaction.reply({ content: `Subscribed you to ${role.name}.`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.customId === 'cs2_unsubscribe') {
      await member.roles.remove(role);
      await interaction.reply({ content: `Unsubscribed you from ${role.name}.`, flags: MessageFlags.Ephemeral });
    }
  }

  getChicagoParts(date) {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: TARGET_TIMEZONE,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
    const parts = formatter.formatToParts(date);
    const get = (type) => Number.parseInt(parts.find((p) => p.type === type).value, 10);
    return {
      year: get('year'),
      month: get('month'),
      day: get('day'),
      hour: get('hour'),
      minute: get('minute')
    };
  }

  async runDailyPromptJob() {
    if (!this.isEnabled()) {
      return { skipped: true, reason: 'notification channel or role is not configured' };
    }

    this.initDb();
    this.loadStateFromDb();
    const channel = await this.client.channels.fetch(this.config.notificationChannelId).catch(() => null);
    if (!channel || !('send' in channel) || !('messages' in channel)) {
      return { skipped: true, reason: 'notification channel is unavailable' };
    }

    await this.postDailyPrompt(channel);
    return { posted: true, messageId: this.state.messageId, dateKey: this.state.messageDateKey };
  }

}

module.exports = {
  NotificationManager
};
