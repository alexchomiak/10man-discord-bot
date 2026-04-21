require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  SlashCommandBuilder
} = require('discord.js');
const { DraftManager } = require('./draftManager');

const token = process.env.DISCORD_TOKEN;
if (!token) {
  throw new Error('Missing DISCORD_TOKEN in environment.');
}

const config = {
  guildId: process.env.DISCORD_GUILD_ID || null,
  minPlayers: Number.parseInt(process.env.MIN_PLAYERS || '4', 10),
  teamCategoryId: process.env.TEAM_CATEGORY_ID || null
};

const draftManager = new DraftManager();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.GuildMember]
});

const teamDraftCommand = new SlashCommandBuilder()
  .setName('team-draft')
  .setDescription('Start a random-captain snake draft for everyone in your current voice channel.')
  .setDMPermission(false);

const teamDraftMockCommand = new SlashCommandBuilder()
  .setName('team-draft-mock')
  .setDescription('Run a mock draft with fake users so you can test solo.')
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
  );

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);

  try {
    if (config.guildId) {
      const guild = await readyClient.guilds.fetch(config.guildId);
      await guild.commands.set([teamDraftCommand, teamDraftMockCommand]);
      console.log(`Registered /team-draft in guild ${guild.name} (${guild.id})`);
    } else {
      await readyClient.application.commands.set([teamDraftCommand, teamDraftMockCommand]);
      console.log('Registered /team-draft and /team-draft-mock globally.');
    }
  } catch (error) {
    console.error('Failed to register slash commands:', error);
  }
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
      await draftManager.runMockDraft(interaction, players, config, spawnVoice);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('draftpick:')) {
      await draftManager.handlePick(interaction, config);
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
