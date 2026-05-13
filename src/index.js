require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags
} = require('discord.js');
const { DraftManager } = require('./draftManager');
const { NotificationManager } = require('./notificationManager');
const { AudioManager } = require('./audioManager');
const { AnnouncementManager } = require('./announcementManager');
const { PlayerManager, summarizeError: summarizePlayerError } = require('./playerManager');
const { COMMANDS, DRAFT_TYPE_CHOICES } = require('./commands.ts');
const { DISCORD_MESSAGES } = require('./messages.ts');

const token = process.env.DISCORD_TOKEN;
if (!token) {
  throw new Error('Missing DISCORD_TOKEN in environment.');
}

const config = {
  guildIds: [...new Set((process.env.DISCORD_GUILD_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean))],
  keepGlobalCommands: process.env.KEEP_GLOBAL_COMMANDS === 'true',
  minPlayers: Number.parseInt(process.env.MIN_PLAYERS || '4', 10),
  teamCategoryId: process.env.TEAM_CATEGORY_ID || null,
  teamNames: (process.env.TEAM_NAMES || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean),
  notificationChannelId: process.env.NOTIFICATION_CHANNEL_ID || null,
  notificationRoleId: process.env.NOTIFICATION_ROLE_ID || null,
  notificationTimeCst: process.env.NOTIFICATION_TIME_CST || '18:00',
  sqlitePath: process.env.SQLITE_PATH || '/app/data/bot.db',
  lobbyMusicPath: process.env.LOBBY_MUSIC_PATH || '/app/data/lobby.mp3',
  audioDebug: process.env.AUDIO_DEBUG === 'true',
  voiceSelfDeaf: process.env.VOICE_SELF_DEAF === 'true',
  ttsLang: process.env.GOOGLE_TTS_LANG || 'en',
  ttsSlow: process.env.GOOGLE_TTS_SLOW === 'true',
  ttsHost: process.env.GOOGLE_TTS_HOST || 'https://translate.google.com',
  audioBufferMs: process.env.AUDIO_BUFFER_MS || '500',
  audioQueueMaxMs: process.env.AUDIO_QUEUE_MAX_MS || '5000',
  announcementCooldownMs: process.env.ANNOUNCEMENT_COOLDOWN_MS || String(10 * 60 * 1000),
  announcementAudioDirectory: process.env.ANNOUNCEMENT_AUDIO_DIRECTORY || null,
  lobbyMusicVolume: process.env.LOBBY_MUSIC_VOLUME || '0.35',
  ttsMusicDuckVolume: process.env.TTS_MUSIC_DUCK_VOLUME || '0.12',
  steamWebApiKey: process.env.STEAM_WEB_API_KEY || null,
  leetifyApiKey: process.env.LEETIFY_API_KEY || null,
  leetifyApiBase: process.env.LEETIFY_API_BASE || 'https://api-public.cs-prod.leetify.com',
  leetifyLegacyApiBase: process.env.LEETIFY_LEGACY_API_BASE || 'https://api.cs-prod.leetify.com',
  ratingRefreshIntervalHours: process.env.RATING_REFRESH_INTERVAL_HOURS || '24'
};


function logVoiceGatewayPacket(packet, botUserId) {
  if (!config.audioDebug) {
    return;
  }

  if (packet.t === 'VOICE_STATE_UPDATE' && packet.d?.user_id === botUserId) {
    console.debug('[audio] raw VOICE_STATE_UPDATE for bot', JSON.stringify({
      guildId: packet.d.guild_id,
      channelId: packet.d.channel_id,
      sessionIdPresent: Boolean(packet.d.session_id),
      selfDeaf: packet.d.self_deaf,
      selfMute: packet.d.self_mute,
      deaf: packet.d.deaf,
      mute: packet.d.mute
    }));
  }

  if (packet.t === 'VOICE_SERVER_UPDATE') {
    console.debug('[audio] raw VOICE_SERVER_UPDATE', JSON.stringify({
      guildId: packet.d?.guild_id,
      endpoint: packet.d?.endpoint || null,
      tokenPresent: Boolean(packet.d?.token)
    }));
  }
}

function audioFailureMessage(error) {
  if (error?.name === 'AudioManagerError') {
    return error.message;
  }

  return DISCORD_MESSAGES.AUDIO_FAILURE;
}

function formatBuildDate(buildDate) {
  if (!buildDate) {
    return 'unknown';
  }

  const parsed = new Date(buildDate);
  if (Number.isNaN(parsed.getTime())) {
    return buildDate;
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  }).format(parsed);
}

function escapeInlineCode(value) {
  return String(value ?? 'none').replace(/`/g, 'ˋ');
}

function parseStoredJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function formatNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Number.parseFloat(value.toFixed(4)).toString()
    : String(value);
}

function formatObjectFields(title, value, limit = 30) {
  const data = parseStoredJson(value);
  if (!data || typeof data !== 'object') {
    return null;
  }

  const entries = Object.entries(data)
    .filter(([, fieldValue]) => fieldValue !== null && fieldValue !== undefined && !Array.isArray(fieldValue) && typeof fieldValue !== 'object')
    .slice(0, limit);

  if (entries.length === 0) {
    return null;
  }

  return [`**${title}**`, ...entries.map(([key, fieldValue]) => `• ${key}: \`${escapeInlineCode(formatNumber(fieldValue))}\``)].join('\n');
}

function formatCompetitiveRanks(value) {
  const ranks = parseStoredJson(value);
  const competitive = Array.isArray(ranks?.competitive)
    ? ranks.competitive.filter((rank) => Number.isInteger(rank?.rank) && rank.rank > 0)
    : [];
  if (competitive.length === 0) {
    return null;
  }

  return [`**Competitive ranks**`, ...competitive.map((rank) => `• ${rank.map_name}: \`${rank.rank}\``)].join('\n');
}

function truncateDiscordMessage(content, maxLength = 1_900) {
  return content.length > maxLength ? `${content.slice(0, maxLength - 14)}\n…truncated` : content;
}

function formatPlayerInfo(link) {
  const sections = [
    [
      `Alias: \`${escapeInlineCode(link.alias)}\``,
      `Normalized alias: \`${escapeInlineCode(link.alias_normalized)}\``,
      `Leetify name: \`${escapeInlineCode(link.leetify_profile_name)}\``,
      `Privacy: \`${escapeInlineCode(link.privacy_mode)}\``,
      `SteamID64: \`${escapeInlineCode(link.steam_id64)}\``,
      `Steam profile: ${link.steam_profile_url}`,
      `Premier rating: ${link.premier_rating ? `**${link.premier_rating}**` : '`none cached`'}`,
      `Rating source: \`${escapeInlineCode(link.rating_source)}\``,
      `Leetify API source: \`${escapeInlineCode(link.leetify_api_source)}\``,
      `Rating updated: \`${escapeInlineCode(link.rating_updated_at)}\``,
      `Total matches: \`${escapeInlineCode(link.total_matches)}\``,
      `Winrate: \`${escapeInlineCode(link.winrate === null || link.winrate === undefined ? null : `${Math.round(link.winrate * 1000) / 10}%`)}\``,
      `First match: \`${escapeInlineCode(link.first_match_date)}\``,
      `Created: \`${escapeInlineCode(link.created_at)}\``,
      `Updated: \`${escapeInlineCode(link.updated_at)}\``
    ].join('\n'),
    formatObjectFields('Ranks', link.ranks_json),
    formatObjectFields('Rating', link.rating_json),
    formatObjectFields('Stats', link.stats_json),
    formatObjectFields('Latest Premier game', link.latest_premier_game_json),
    formatCompetitiveRanks(link.ranks_json)
  ].filter(Boolean);

  return truncateDiscordMessage(sections.join('\n\n'));
}

function formatRefreshSummary(result) {
  return `Refreshed Premier ratings for ${result.updated}/${result.total} linked players${result.failed ? ` (${result.failed} failed)` : ''}.`;
}

async function getInvokerVoiceMembers(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const voiceChannel = member.voice?.channel;
  if (!voiceChannel) {
    return null;
  }

  return voiceChannel.members.filter((voiceMember) => !voiceMember.user.bot);
}

const audioManager = new AudioManager(config);
const playerManager = new PlayerManager(config);
const draftManager = new DraftManager(audioManager, playerManager);
const announcementManager = new AnnouncementManager(config, audioManager, draftManager);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.GuildMember]
});
const notificationManager = new NotificationManager(client, config);

const teamDraftCommand = new SlashCommandBuilder()
  .setName(COMMANDS.TEAM_DRAFT.name)
  .setDescription(COMMANDS.TEAM_DRAFT.description)
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false)
  .addIntegerOption((option) =>
    option
      .setName(COMMANDS.TEAM_DRAFT.options.PLAYERS.name)
      .setDescription(COMMANDS.TEAM_DRAFT.options.PLAYERS.description)
      .setMinValue(4)
  )
  .addUserOption((option) =>
    option
      .setName(COMMANDS.TEAM_DRAFT.options.CAPTAIN_1.name)
      .setDescription(COMMANDS.TEAM_DRAFT.options.CAPTAIN_1.description)
  )
  .addUserOption((option) =>
    option
      .setName(COMMANDS.TEAM_DRAFT.options.CAPTAIN_2.name)
      .setDescription(COMMANDS.TEAM_DRAFT.options.CAPTAIN_2.description)
  )
  .addStringOption((option) =>
    option
      .setName(COMMANDS.TEAM_DRAFT.options.DRAFT_TYPE.name)
      .setDescription(COMMANDS.TEAM_DRAFT.options.DRAFT_TYPE.description)
      .addChoices(
        DRAFT_TYPE_CHOICES.SNAKE,
        DRAFT_TYPE_CHOICES.REGULAR
      )
  )
  .addBooleanOption((option) =>
    option
      .setName(COMMANDS.TEAM_DRAFT.options.REFRESH_RATINGS.name)
      .setDescription(COMMANDS.TEAM_DRAFT.options.REFRESH_RATINGS.description)
  );

const teamDraftMockCommand = new SlashCommandBuilder()
  .setName(COMMANDS.TEAM_DRAFT_MOCK.name)
  .setDescription(COMMANDS.TEAM_DRAFT_MOCK.description)
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false)
  .addIntegerOption((option) =>
    option
      .setName(COMMANDS.TEAM_DRAFT_MOCK.options.PLAYERS.name)
      .setDescription(COMMANDS.TEAM_DRAFT_MOCK.options.PLAYERS.description)
      .setRequired(true)
      .setMinValue(4)
  )
  .addBooleanOption((option) =>
    option
      .setName(COMMANDS.TEAM_DRAFT_MOCK.options.SPAWN_VOICE.name)
      .setDescription(COMMANDS.TEAM_DRAFT_MOCK.options.SPAWN_VOICE.description)
  )
  .addBooleanOption((option) =>
    option
      .setName(COMMANDS.TEAM_DRAFT_MOCK.options.BROADCAST.name)
      .setDescription(COMMANDS.TEAM_DRAFT_MOCK.options.BROADCAST.description)
  )
  .addStringOption((option) =>
    option
      .setName(COMMANDS.TEAM_DRAFT_MOCK.options.DRAFT_TYPE.name)
      .setDescription(COMMANDS.TEAM_DRAFT_MOCK.options.DRAFT_TYPE.description)
      .addChoices(
        DRAFT_TYPE_CHOICES.SNAKE,
        DRAFT_TYPE_CHOICES.REGULAR
      )
  );


const linkCommand = new SlashCommandBuilder()
  .setName(COMMANDS.LINK.name)
  .setDescription(COMMANDS.LINK.description)
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName(COMMANDS.LINK.options.ALIAS.name)
      .setDescription(COMMANDS.LINK.options.ALIAS.description)
      .setRequired(true)
      .setMaxLength(100)
  )
  .addStringOption((option) =>
    option
      .setName(COMMANDS.LINK.options.URL.name)
      .setDescription(COMMANDS.LINK.options.URL.description)
      .setRequired(true)
  );

const unlinkCommand = new SlashCommandBuilder()
  .setName(COMMANDS.UNLINK.name)
  .setDescription(COMMANDS.UNLINK.description)
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName(COMMANDS.UNLINK.options.ALIAS.name)
      .setDescription(COMMANDS.UNLINK.options.ALIAS.description)
      .setRequired(true)
      .setMaxLength(100)
  );

const getInfoCommand = new SlashCommandBuilder()
  .setName(COMMANDS.GET_INFO.name)
  .setDescription(COMMANDS.GET_INFO.description)
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName(COMMANDS.GET_INFO.options.ALIAS.name)
      .setDescription(COMMANDS.GET_INFO.options.ALIAS.description)
      .setRequired(true)
      .setMaxLength(100)
  );

const refreshCommand = new SlashCommandBuilder()
  .setName(COMMANDS.REFRESH.name)
  .setDescription(COMMANDS.REFRESH.description)
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName(COMMANDS.REFRESH.options.ALIAS.name)
      .setDescription(COMMANDS.REFRESH.options.ALIAS.description)
      .setRequired(true)
      .setMaxLength(100)
  );

const refreshVoiceCommand = new SlashCommandBuilder()
  .setName(COMMANDS.REFRESH_VOICE.name)
  .setDescription(COMMANDS.REFRESH_VOICE.description)
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false);

const leaderboardCommand = new SlashCommandBuilder()
  .setName(COMMANDS.LEADERBOARD.name)
  .setDescription(COMMANDS.LEADERBOARD.description)
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false);

const refreshLeaderboardCommand = new SlashCommandBuilder()
  .setName(COMMANDS.REFRESH_LEADERBOARD.name)
  .setDescription(COMMANDS.REFRESH_LEADERBOARD.description)
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false);

const draftStatusCommand = new SlashCommandBuilder()
  .setName(COMMANDS.DRAFT_STATUS.name)
  .setDescription(COMMANDS.DRAFT_STATUS.description)
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false);

const draftCancelCommand = new SlashCommandBuilder()
  .setName(COMMANDS.DRAFT_CANCEL.name)
  .setDescription(COMMANDS.DRAFT_CANCEL.description)
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false);

const draftCleanupCommand = new SlashCommandBuilder()
  .setName(COMMANDS.DRAFT_CLEANUP.name)
  .setDescription(COMMANDS.DRAFT_CLEANUP.description)
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false);

const returnToVoiceCommand = new SlashCommandBuilder()
  .setName(COMMANDS.RETURN_TO_VOICE.name)
  .setDescription(COMMANDS.RETURN_TO_VOICE.description)
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false);

const buildVersionCommand = new SlashCommandBuilder()
  .setName(COMMANDS.BUILD_VERSION.name)
  .setDescription(COMMANDS.BUILD_VERSION.description)
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false);

const testLobbyMusicCommand = new SlashCommandBuilder()
  .setName(COMMANDS.TEST_LOBBY_MUSIC.name)
  .setDescription(COMMANDS.TEST_LOBBY_MUSIC.description)
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false);

const testTtsCommand = new SlashCommandBuilder()
  .setName(COMMANDS.TEST_TTS.name)
  .setDescription(COMMANDS.TEST_TTS.description)
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName(COMMANDS.TEST_TTS.options.MESSAGE.name)
      .setDescription(COMMANDS.TEST_TTS.options.MESSAGE.description)
      .setRequired(true)
      .setMaxLength(200)
  );


const announceCommand = new SlashCommandBuilder()
  .setName(COMMANDS.ANNOUNCE.name)
  .setDescription(COMMANDS.ANNOUNCE.description)
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false)
  .addUserOption((option) =>
    option
      .setName(COMMANDS.ANNOUNCE.options.ALIAS.name)
      .setDescription(COMMANDS.ANNOUNCE.options.ALIAS.description)
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName(COMMANDS.ANNOUNCE.options.FILENAME.name)
      .setDescription(COMMANDS.ANNOUNCE.options.FILENAME.description)
      .setRequired(true)
      .setMaxLength(100)
  );


const resetAnnounceTimerCommand = new SlashCommandBuilder()
  .setName(COMMANDS.RESET_ANNOUNCE_TIMER.name)
  .setDescription(COMMANDS.RESET_ANNOUNCE_TIMER.description)
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false)
  .addUserOption((option) =>
    option
      .setName(COMMANDS.RESET_ANNOUNCE_TIMER.options.ALIAS.name)
      .setDescription(COMMANDS.RESET_ANNOUNCE_TIMER.options.ALIAS.description)
      .setRequired(true)
  );

const removeAnnouncementCommand = new SlashCommandBuilder()
  .setName(COMMANDS.REMOVE_ANNOUNCEMENT.name)
  .setDescription(COMMANDS.REMOVE_ANNOUNCEMENT.description)
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false)
  .addUserOption((option) =>
    option
      .setName(COMMANDS.REMOVE_ANNOUNCEMENT.options.ALIAS.name)
      .setDescription(COMMANDS.REMOVE_ANNOUNCEMENT.options.ALIAS.description)
      .setRequired(true)
  );

const audioStatusCommand = new SlashCommandBuilder()
  .setName(COMMANDS.AUDIO_STATUS.name)
  .setDescription(COMMANDS.AUDIO_STATUS.description)
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false);

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  try {
    const commands = [teamDraftCommand, teamDraftMockCommand, linkCommand, unlinkCommand, getInfoCommand, refreshCommand, refreshVoiceCommand, leaderboardCommand, refreshLeaderboardCommand, draftStatusCommand, draftCancelCommand, draftCleanupCommand, returnToVoiceCommand, buildVersionCommand, testLobbyMusicCommand, testTtsCommand, announceCommand, resetAnnounceTimerCommand, removeAnnouncementCommand, audioStatusCommand];

    if (config.guildIds.length > 0) {
      if (!config.keepGlobalCommands) {
        await readyClient.application.commands.set([]);
        console.log('Cleared global commands to avoid duplicate global+guild command entries.');
      }

      for (const guildId of config.guildIds) {
        const guild = await readyClient.guilds.fetch(guildId);
        await guild.commands.set(commands);
        console.log(`Registered draft commands in guild ${guild.name} (${guild.id})`);
      }
    } else {
      await readyClient.application.commands.set(commands);
      console.log('Registered draft commands globally (can take up to 1 hour to appear).');
      console.log('Tip: set DISCORD_GUILD_ID to your server ID for near-instant command updates.');
    }
  } catch (error) {
    console.error('Failed to register slash commands:', error);
  }

  playerManager.start(readyClient);
  await notificationManager.start();
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.TEAM_DRAFT.name) {
      await draftManager.startDraft(interaction, config);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.TEAM_DRAFT_MOCK.name) {
      const players = interaction.options.getInteger(COMMANDS.TEAM_DRAFT_MOCK.options.PLAYERS.name, true);
      const spawnVoice = interaction.options.getBoolean(COMMANDS.TEAM_DRAFT_MOCK.options.SPAWN_VOICE.name) ?? true;
      const broadcast = interaction.options.getBoolean(COMMANDS.TEAM_DRAFT_MOCK.options.BROADCAST.name) ?? true;
      const draftType = interaction.options.getString(COMMANDS.TEAM_DRAFT_MOCK.options.DRAFT_TYPE.name) ?? DRAFT_TYPE_CHOICES.SNAKE.value;
      await draftManager.runMockDraft(interaction, players, config, spawnVoice, broadcast, draftType);
      return;
    }


    if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.LINK.name) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const linked = await playerManager.link(
          interaction.options.getString(COMMANDS.LINK.options.ALIAS.name, true),
          interaction.options.getString(COMMANDS.LINK.options.URL.name, true)
        );
        await interaction.editReply({
          content: linked.premier_rating
            ? `Linked \`${linked.alias}\` to SteamID64 \`${linked.steam_id64}\` with Premier rating **${linked.premier_rating}**.`
            : `Linked \`${linked.alias}\` to SteamID64 \`${linked.steam_id64}\`. No Premier rating was available yet.`
        });
      } catch (error) {
        console.error('Failed to link player:', summarizePlayerError(error));
        await interaction.editReply({ content: error.message || 'Failed to link player.' });
      }
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.UNLINK.name) {
      const alias = interaction.options.getString(COMMANDS.UNLINK.options.ALIAS.name, true);
      const removed = playerManager.unlink(alias);
      await interaction.reply({
        content: removed ? `Unlinked \`${alias}\`.` : `No link found for \`${alias}\`.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.GET_INFO.name) {
      const alias = interaction.options.getString(COMMANDS.GET_INFO.options.ALIAS.name, true);
      const link = playerManager.getByAlias(alias);
      await interaction.reply({
        content: link
          ? formatPlayerInfo(link)
          : `No player link found for \`${escapeInlineCode(alias)}\`. Use /${COMMANDS.LINK.name} first to create a DB record.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.REFRESH.name) {
      const alias = interaction.options.getString(COMMANDS.REFRESH.options.ALIAS.name, true);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const link = await playerManager.refreshRatingForAlias(alias);
        await interaction.editReply({
          content: link
            ? [`Refreshed \`${escapeInlineCode(link.alias)}\`.`, '', formatPlayerInfo(link)].join('\n')
            : `No player link found for \`${escapeInlineCode(alias)}\`. Use /${COMMANDS.LINK.name} first to create a DB record.`
        });
      } catch (error) {
        console.error('Failed to refresh player:', summarizePlayerError(error));
        await interaction.editReply({ content: error.message || 'Failed to refresh player metadata.' });
      }
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.REFRESH_VOICE.name) {
      const members = await getInvokerVoiceMembers(interaction);
      if (!members) {
        await interaction.reply({ content: DISCORD_MESSAGES.JOIN_VOICE_FIRST, flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const result = await playerManager.refreshRatingsForMembers(members);
        await interaction.editReply({ content: formatRefreshSummary(result) });
      } catch (error) {
        console.error('Failed to refresh voice players:', summarizePlayerError(error));
        await interaction.editReply({ content: error.message || 'Failed to refresh voice player metadata.' });
      }
      return;
    }


    if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.LEADERBOARD.name) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const result = await playerManager.createOrUpdateLeaderboard(
          interaction.guildId,
          interaction.channel,
          interaction.guild?.name || 'Server'
        );
        await interaction.editReply({
          content: result.created
            ? `Created leaderboard: ${result.message.url}`
            : `Updated existing leaderboard: ${result.message.url}`
        });
      } catch (error) {
        console.error('Failed to create/update leaderboard:', summarizePlayerError(error));
        await interaction.editReply({ content: error.message || 'Failed to create or update leaderboard.' });
      }
      return;
    }


    if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.REFRESH_LEADERBOARD.name) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const result = await playerManager.updateLeaderboard(
          interaction.guildId,
          interaction.guild?.name || 'Server'
        );
        await interaction.editReply({
          content: result.updated
            ? `Refreshed leaderboard: ${result.message.url}`
            : result.reason
        });
      } catch (error) {
        console.error('Failed to refresh leaderboard:', summarizePlayerError(error));
        await interaction.editReply({ content: error.message || 'Failed to refresh leaderboard.' });
      }
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.DRAFT_STATUS.name) {
      await draftManager.getDraftStatus(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.DRAFT_CANCEL.name) {
      await draftManager.cancelDraft(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.DRAFT_CLEANUP.name) {
      await draftManager.cleanupDraft(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.BUILD_VERSION.name) {
      const version = process.env.BUILD_VERSION || 'dev';
      const buildDate = formatBuildDate(process.env.BUILD_DATE);
      await interaction.reply({
        content: [`Build Version: \`${version}\``, '', `Build was merged on ${buildDate}`].join('\n'),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.TEST_LOBBY_MUSIC.name) {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const voiceChannel = member.voice?.channel;
      if (!voiceChannel) {
        await interaction.reply({ content: DISCORD_MESSAGES.JOIN_VOICE_FIRST, flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        await audioManager.join(voiceChannel);
      } catch (error) {
        console.error('Failed to join voice for lobby music test:', error);
        await interaction.editReply({ content: audioFailureMessage(error) });
        return;
      }

      await interaction.editReply({
        content: audioManager.hasMusicFile()
          ? DISCORD_MESSAGES.lobbyMusicQueued
          : DISCORD_MESSAGES.lobbyMusicMissing(config.lobbyMusicPath)
      });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.TEST_TTS.name) {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const voiceChannel = member.voice?.channel;
      if (!voiceChannel) {
        await interaction.reply({ content: DISCORD_MESSAGES.JOIN_VOICE_FIRST, flags: MessageFlags.Ephemeral });
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        await audioManager.join(voiceChannel);
      } catch (error) {
        console.error('Failed to join voice for TTS test:', error);
        await interaction.editReply({ content: audioFailureMessage(error) });
        return;
      }

      const message = interaction.options.getString(COMMANDS.TEST_TTS.options.MESSAGE.name, true);
      const spoke = await audioManager.speak(interaction.guildId, message);
      const audioStatus = audioManager.status(interaction.guildId);
      const voiceReady = audioStatus?.connectionStatus === 'ready';
      await interaction.editReply({
        content: spoke
          ? [
              voiceReady
                ? DISCORD_MESSAGES.ttsQueued
                : DISCORD_MESSAGES.ttsQueuedWaiting(audioStatus?.connectionStatus),
              audioStatus?.queue?.speechQueuedMs ? DISCORD_MESSAGES.ttsSpeechQueued(audioStatus.queue.speechQueuedMs) : null
            ].filter(Boolean).join('\n')
          : DISCORD_MESSAGES.ttsFailed
      });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.ANNOUNCE.name) {
      await announcementManager.handleAnnounceCommand(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.RESET_ANNOUNCE_TIMER.name) {
      await announcementManager.handleResetAnnounceTimerCommand(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.REMOVE_ANNOUNCEMENT.name) {
      await announcementManager.handleRemoveAnnouncementCommand(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.AUDIO_STATUS.name) {
      const status = audioManager.status(interaction.guildId);
      const dependencyReport = audioManager.dependencyReport();
      await interaction.reply({
        content: [
          status
            ? `Connection: \`${status.connectionStatus}\` | Player: \`${status.playerStatus}\` | Speech enabled: \`${status.queue.speechEnabled}\` | Speech queued: \`${status.queue.speechQueuedMs}ms\``
            : 'No active audio session in this server.',
          '',
          'Dependency report:',
          '```',
          dependencyReport.slice(0, 1_700),
          '```'
        ].join('\n'),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.RETURN_TO_VOICE.name) {
      await draftManager.returnToVoice(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('draftpick:')) {
      await draftManager.handlePick(interaction, config);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('mockstart:')) {
      await draftManager.handleMockStartButton(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('draftstart:')) {
      await draftManager.handleStartDraftButton(interaction, config);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('draftabort:')) {
      await draftManager.handleAbortDraftButton(interaction);
      return;
    }

    if (notificationManager.isEnabled() && interaction.isButton() && interaction.customId.startsWith('cs2_')) {
      await notificationManager.handleButton(interaction);
    }
  } catch (error) {
    console.error('Interaction error:', error);
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: 'Something went wrong handling that interaction.', flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content: 'Something went wrong handling that interaction.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});


client.on(Events.Raw, (packet) => {
  logVoiceGatewayPacket(packet, client.user?.id);
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    await draftManager.handleVoiceStateUpdate(oldState, newState);
    await announcementManager.handleVoiceStateUpdate(oldState, newState);
  } catch (error) {
    console.error('Voice cleanup error:', error);
  }
});

client.login(token);
