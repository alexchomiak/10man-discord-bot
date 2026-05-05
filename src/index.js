require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  SlashCommandBuilder,
  InteractionContextType
} = require('discord.js');
const { DraftManager } = require('./draftManager');
const { NotificationManager } = require('./notificationManager');

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
  notificationChannelId: process.env.NOTIFICATION_CHANNEL_ID || null,
  notificationRoleId: process.env.NOTIFICATION_ROLE_ID || null,
  notificationTimeCst: process.env.NOTIFICATION_TIME_CST || '18:00',
  sqlitePath: process.env.SQLITE_PATH || '/app/data/bot.db'
};

const draftManager = new DraftManager();

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
  .setDescription('Start a random-captain snake draft for everyone in your current voice channel.')
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
      .setDescription('Also create a temporary private mock voice channel and move you there.')
  )
  .addBooleanOption((option) =>
    option
      .setName('broadcast')
      .setDescription('Broadcast mock draft results to the channel (default true).')
  );

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

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  try {
    const commands = [teamDraftCommand, teamDraftMockCommand, draftStatusCommand, draftCancelCommand, draftCleanupCommand];

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
      await draftManager.runMockDraft(interaction, players, config, spawnVoice, broadcast);
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

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('draftpick:')) {
      await draftManager.handlePick(interaction, config);
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
      await interaction.followUp({ content: 'Something went wrong handling that interaction.', ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: 'Something went wrong handling that interaction.', ephemeral: true }).catch(() => {});
    }
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    await draftManager.handleVoiceStateUpdate(oldState, newState);
  } catch (error) {
    console.error('Voice cleanup error:', error);
  }
});

client.login(token);
