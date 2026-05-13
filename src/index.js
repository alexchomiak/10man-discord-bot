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
const { PlayerManager, summarizeError: summarizePlayerError } = require('./playerManager');

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

  return 'Voice audio failed. Check that I have permission to join and speak in that channel, then try again.';
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
  .setName('team-draft')
  .setDescription('Start a random-captain team draft for everyone in your current voice channel.')
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false)
  .addIntegerOption((option) =>
    option
      .setName('players')
      .setDescription('Optional even total players to draft; all voice members remain draftable.')
      .setMinValue(4)
  )
  .addUserOption((option) =>
    option
      .setName('captain1')
      .setDescription('Optional first captain (must be in the same voice channel).')
  )
  .addUserOption((option) =>
    option
      .setName('captain2')
      .setDescription('Optional second captain (must be in the same voice channel).')
  )
  .addStringOption((option) =>
    option
      .setName('draft_type')
      .setDescription('Draft order type (default: snake).')
      .addChoices(
        { name: 'Snake', value: 'snake' },
        { name: 'Regular alternating', value: 'regular' }
      )
  )
  .addBooleanOption((option) =>
    option
      .setName('refresh_ratings')
      .setDescription('Refresh linked Premier ratings before starting this draft (default false).')
  );

const teamDraftMockCommand = new SlashCommandBuilder()
  .setName('team-draft-mock')
  .setDescription('Run a mock draft with fake users so you can test solo.')
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false)
  .addIntegerOption((option) =>
    option
      .setName('players')
      .setDescription('Even number of fake players (minimum 4).')
      .setRequired(true)
      .setMinValue(4)
  )
  .addBooleanOption((option) =>
    option
      .setName('spawn_voice')
      .setDescription('After Start Mock Match, create a temporary private mock voice channel and move you there.')
  )
  .addBooleanOption((option) =>
    option
      .setName('broadcast')
      .setDescription('Broadcast mock draft results to the channel (default true).')
  )
  .addStringOption((option) =>
    option
      .setName('draft_type')
      .setDescription('Draft order type (default: snake).')
      .addChoices(
        { name: 'Snake', value: 'snake' },
        { name: 'Regular alternating', value: 'regular' }
      )
  );


const linkCommand = new SlashCommandBuilder()
  .setName('link')
  .setDescription('Link a player alias to a Steam profile and store their CS Premier rating.')
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName('alias')
      .setDescription('Alias/display name to use for draft rating labels.')
      .setRequired(true)
      .setMaxLength(100)
  )
  .addStringOption((option) =>
    option
      .setName('url')
      .setDescription('Steam profile URL, e.g. steamcommunity.com/id/foo or /profiles/SteamID64.')
      .setRequired(true)
  );

const unlinkCommand = new SlashCommandBuilder()
  .setName('unlink')
  .setDescription('Remove a linked player alias from the local rating database.')
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName('alias')
      .setDescription('Alias to unlink.')
      .setRequired(true)
      .setMaxLength(100)
  );

const getInfoCommand = new SlashCommandBuilder()
  .setName('get-info')
  .setDescription('Show the stored Steam/Premier DB record for a linked player alias.')
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName('alias')
      .setDescription('Alias to look up in the player link database.')
      .setRequired(true)
      .setMaxLength(100)
  );

const refreshCommand = new SlashCommandBuilder()
  .setName('refresh')
  .setDescription('Refresh Leetify Premier metadata for one linked player alias.')
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName('alias')
      .setDescription('Alias to refresh in the player link database.')
      .setRequired(true)
      .setMaxLength(100)
  );

const refreshVoiceCommand = new SlashCommandBuilder()
  .setName('refresh-voice')
  .setDescription('Refresh Leetify Premier metadata for linked players in your voice channel.')
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false);

const leaderboardCommand = new SlashCommandBuilder()
  .setName('leaderboard')
  .setDescription('Create or update this server’s maintained CS2 ratings leaderboard.')
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false);

const draftStatusCommand = new SlashCommandBuilder()
  .setName('draft-status')
  .setDescription('Show current draft/mock status for this server.')
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false);

const draftCancelCommand = new SlashCommandBuilder()
  .setName('draft-cancel')
  .setDescription('Cancel the active draft in this server and clean temporary resources.')
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false);

const draftCleanupCommand = new SlashCommandBuilder()
  .setName('draft-cleanup')
  .setDescription('Force cleanup of active draft/mock temporary channels and roles.')
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false);

const returnToVoiceCommand = new SlashCommandBuilder()
  .setName('return-to-voice')
  .setDescription('Move drafted players back to the original voice channel and cleanup draft resources.')
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false);

const buildVersionCommand = new SlashCommandBuilder()
  .setName('build-version')
  .setDescription('Show the currently running build commit hash.')
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false);

const testLobbyMusicCommand = new SlashCommandBuilder()
  .setName('test-lobby-music')
  .setDescription('Join your voice channel and play lobby music if /app/data/lobby.mp3 exists.')
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false);

const testTtsCommand = new SlashCommandBuilder()
  .setName('test-tts')
  .setDescription('Make the bot say a test message in voice.')
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false)
  .addStringOption((option) =>
    option
      .setName('message')
      .setDescription('Message for the bot to say in voice.')
      .setRequired(true)
      .setMaxLength(200)
  );

const audioStatusCommand = new SlashCommandBuilder()
  .setName('audio-status')
  .setDescription('Show Discord voice/TTS diagnostics for this server.')
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false);

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  try {
    const commands = [teamDraftCommand, teamDraftMockCommand, linkCommand, unlinkCommand, getInfoCommand, refreshCommand, refreshVoiceCommand, leaderboardCommand, draftStatusCommand, draftCancelCommand, draftCleanupCommand, returnToVoiceCommand, buildVersionCommand, testLobbyMusicCommand, testTtsCommand, audioStatusCommand];

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
    if (interaction.isChatInputCommand() && interaction.commandName === 'team-draft') {
      await draftManager.startDraft(interaction, config);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'team-draft-mock') {
      const players = interaction.options.getInteger('players', true);
      const spawnVoice = interaction.options.getBoolean('spawn_voice') ?? true;
      const broadcast = interaction.options.getBoolean('broadcast') ?? true;
      const draftType = interaction.options.getString('draft_type') ?? 'snake';
      await draftManager.runMockDraft(interaction, players, config, spawnVoice, broadcast, draftType);
      return;
    }


    if (interaction.isChatInputCommand() && interaction.commandName === 'link') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const linked = await playerManager.link(
          interaction.options.getString('alias', true),
          interaction.options.getString('url', true)
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

    if (interaction.isChatInputCommand() && interaction.commandName === 'unlink') {
      const alias = interaction.options.getString('alias', true);
      const removed = playerManager.unlink(alias);
      await interaction.reply({
        content: removed ? `Unlinked \`${alias}\`.` : `No link found for \`${alias}\`.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'get-info') {
      const alias = interaction.options.getString('alias', true);
      const link = playerManager.getByAlias(alias);
      await interaction.reply({
        content: link
          ? formatPlayerInfo(link)
          : `No player link found for \`${escapeInlineCode(alias)}\`. Use /link first to create a DB record.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'refresh') {
      const alias = interaction.options.getString('alias', true);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const link = await playerManager.refreshRatingForAlias(alias);
        await interaction.editReply({
          content: link
            ? [`Refreshed \`${escapeInlineCode(link.alias)}\`.`, '', formatPlayerInfo(link)].join('\n')
            : `No player link found for \`${escapeInlineCode(alias)}\`. Use /link first to create a DB record.`
        });
      } catch (error) {
        console.error('Failed to refresh player:', summarizePlayerError(error));
        await interaction.editReply({ content: error.message || 'Failed to refresh player metadata.' });
      }
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'refresh-voice') {
      const members = await getInvokerVoiceMembers(interaction);
      if (!members) {
        await interaction.reply({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
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


    if (interaction.isChatInputCommand() && interaction.commandName === 'leaderboard') {
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

    if (interaction.isChatInputCommand() && interaction.commandName === 'draft-status') {
      await draftManager.getDraftStatus(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'draft-cancel') {
      await draftManager.cancelDraft(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'draft-cleanup') {
      await draftManager.cleanupDraft(interaction);
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'build-version') {
      const version = process.env.BUILD_VERSION || 'dev';
      const buildDate = formatBuildDate(process.env.BUILD_DATE);
      await interaction.reply({
        content: [`Build Version: \`${version}\``, '', `Build was merged on ${buildDate}`].join('\n'),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'test-lobby-music') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const voiceChannel = member.voice?.channel;
      if (!voiceChannel) {
        await interaction.reply({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
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
          ? 'Joined voice and started/queued lobby music.'
          : `Joined voice, but no lobby music file exists at \`${config.lobbyMusicPath}\`.`
      });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'test-tts') {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const voiceChannel = member.voice?.channel;
      if (!voiceChannel) {
        await interaction.reply({ content: 'Join a voice channel first.', flags: MessageFlags.Ephemeral });
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

      const message = interaction.options.getString('message', true);
      const spoke = await audioManager.speak(interaction.guildId, message);
      const audioStatus = audioManager.status(interaction.guildId);
      const voiceReady = audioStatus?.connectionStatus === 'ready';
      await interaction.editReply({
        content: spoke
          ? [
              voiceReady
                ? 'Queued TTS test to voice.'
                : `Queued TTS, but Discord voice is still ${audioStatus?.connectionStatus || 'not ready'} so speech is being held until the connection becomes ready.`,
              audioStatus?.queue?.speechQueuedMs ? `Speech queued: ~${audioStatus.queue.speechQueuedMs}ms.` : null
            ].filter(Boolean).join('\n')
          : 'I joined voice, but TTS generation or playback failed. Check the bot logs for the detailed TTS error.'
      });
      return;
    }

    if (interaction.isChatInputCommand() && interaction.commandName === 'audio-status') {
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

    if (interaction.isChatInputCommand() && interaction.commandName === 'return-to-voice') {
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
  } catch (error) {
    console.error('Voice cleanup error:', error);
  }
});

client.login(token);
