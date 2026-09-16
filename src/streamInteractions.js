'use strict';

const {
  SlashCommandBuilder,
  InteractionContextType,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');
const { parseSignedDuration } = require('./streambot/sources');

const STREAM_COMMAND = 'stream';
const PLAYER_COMMAND = 'player';
const SET_STREAM_NAME_COMMAND = 'set-stream-name';
const BUTTON_PREFIX = 'stream-player';

function addWorkerOption(builder) {
  return builder.addStringOption(option => option
    .setName('bot')
    .setDescription('Streambot ID; defaults to the primary streambot.')
    .setAutocomplete(true));
}

const streamCommand = new SlashCommandBuilder()
  .setName(STREAM_COMMAND)
  .setDescription('Control a Discord go-live streambot.')
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false)
  .addSubcommand(sub => addWorkerOption(sub.setName('ping').setDescription('Check whether a streambot is responsive.')))
  .addSubcommand(sub => addWorkerOption(sub.setName('play').setDescription('Play or queue a stream.')
    .addStringOption(option => option.setName('source').setDescription('Video URL or ShareTV slug.').setRequired(true))))
  .addSubcommand(sub => addWorkerOption(sub.setName('join').setDescription('Join your voice channel and warm up go-live.')))
  .addSubcommand(sub => addWorkerOption(sub.setName('stop').setDescription('Stop playback and leave voice.')))
  .addSubcommand(sub => addWorkerOption(sub.setName('status').setDescription('Show current playback status.')))
  .addSubcommand(sub => addWorkerOption(sub.setName('skip').setDescription('Skip to the next queued video.')))
  .addSubcommand(sub => addWorkerOption(sub.setName('scrub').setDescription('Seek forward or backward in a VOD.')
    .addStringOption(option => option.setName('offset').setDescription('Signed offset such as +30s, -1m, or +10m.').setRequired(true))))
  .addSubcommand(sub => addWorkerOption(sub.setName('pause').setDescription('Pause the current video.')))
  .addSubcommand(sub => addWorkerOption(sub.setName('resume').setDescription('Resume a paused video.')))
  .addSubcommand(sub => addWorkerOption(sub.setName('catchup').setDescription('Jump a live stream to its live head.')));

const playerCommand = addWorkerOption(new SlashCommandBuilder()
  .setName(PLAYER_COMMAND)
  .setDescription('Open interactive playback controls for a streambot.')
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false));

const setStreamNameCommand = addWorkerOption(new SlashCommandBuilder()
  .setName(SET_STREAM_NAME_COMMAND)
  .setDescription("Change a streambot's nickname in this server.")
  .setContexts(InteractionContextType.Guild)
  .setDMPermission(false)
  .addStringOption(option => option
    .setName('name')
    .setDescription('New server nickname (1–32 characters).')
    .setMinLength(1)
    .setMaxLength(32)
    .setRequired(true)));

function allowed(interaction, allowedUserIds) {
  return !Array.isArray(allowedUserIds) || !allowedUserIds.length || allowedUserIds.includes(String(interaction.user.id));
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return 'unknown';
  const value = Math.max(0, Math.round(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function playerComponents(workerId) {
  const button = (label, action, style = ButtonStyle.Secondary) => new ButtonBuilder()
    .setCustomId(`${BUTTON_PREFIX}|${workerId}|${action}`)
    .setLabel(label)
    .setStyle(style);
  return [
    new ActionRowBuilder().addComponents(
      button('Pause', 'pause', ButtonStyle.Primary),
      button('Resume', 'resume', ButtonStyle.Success)
    ),
    new ActionRowBuilder().addComponents(
      button('−1m', 'scrub:-60'), button('−30s', 'scrub:-30'), button('−5s', 'scrub:-5')
    ),
    new ActionRowBuilder().addComponents(
      button('+5s', 'scrub:5'), button('+30s', 'scrub:30'), button('+1m', 'scrub:60')
    )
  ];
}

function playerText(workerId, result) {
  const status = result?.status;
  const lines = [`**Stream player — \`${workerId}\`**`];
  if (!status) lines.push('Status: idle');
  else {
    lines.push(`Status: ${status.paused ? 'paused' : status.isFiller ? 'warming up' : 'playing'}`);
    if (status.title) lines.push(`Title: ${status.title}`);
    lines.push(`Position: ${formatTime(status.positionSec)}`);
    lines.push(`Queue: ${status.queued || 0}`);
    if (status.isLive) lines.push('Source: live');
  }
  if (result?.message) lines.push('', result.message);
  return lines.join('\n').slice(0, 1900);
}

async function autocomplete(interaction, broker) {
  if (![STREAM_COMMAND, PLAYER_COMMAND, SET_STREAM_NAME_COMMAND].includes(interaction.commandName)) return false;
  const focused = interaction.options.getFocused(true);
  if (focused.name !== 'bot') return false;
  const query = String(focused.value || '').toLowerCase();
  const choices = broker.listWorkers()
    .map(worker => worker.id)
    .filter(id => id.toLowerCase().includes(query))
    .slice(0, 25)
    .map(id => ({ name: id === broker.defaultWorkerId ? `${id} (default)` : id, value: id }));
  await interaction.respond(choices);
  return true;
}

async function targetVoice(interaction) {
  const member = await interaction.guild.members.fetch(interaction.user.id);
  return member.voice?.channelId || null;
}

async function setStreambotNickname(interaction, broker, workerId, name) {
  if (name.length < 1 || name.length > 32) {
    throw new Error('Nickname must be between 1 and 32 characters.');
  }
  const worker = broker.getWorker(workerId);
  if (!worker?.userId) {
    throw new Error(`Streambot '${workerId}' is offline or has not registered its Discord user ID.`);
  }
  const member = await interaction.guild.members.fetch(worker.userId);
  if (member.manageable === false) {
    throw new Error(`I cannot change '${workerId}' in this server. Give the CS bot Manage Nicknames and place its role above the streambot's highest role.`);
  }
  await member.setNickname(name, `Stream name set by ${interaction.user.id}`);
  return `Nickname changed to ${name} in ${interaction.guild.name}.`;
}

async function handleCommand(interaction, broker, allowedUserIds) {
  if (![STREAM_COMMAND, PLAYER_COMMAND, SET_STREAM_NAME_COMMAND].includes(interaction.commandName)) return false;
  if (!allowed(interaction, allowedUserIds)) {
    await interaction.reply({ content: 'You are not allowed to control streambots.', flags: MessageFlags.Ephemeral });
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const requested = interaction.options.getString('bot') || null;
  const workerId = broker.resolveWorkerId(requested);
  try {
    if (interaction.commandName === PLAYER_COMMAND) {
      const result = await broker.request('status', { requestedBy: interaction.user.id }, workerId);
      await interaction.editReply({ content: playerText(workerId, result), components: playerComponents(workerId) });
      return true;
    }
    if (interaction.commandName === SET_STREAM_NAME_COMMAND) {
      const message = await setStreambotNickname(
        interaction,
        broker,
        workerId,
        interaction.options.getString('name', true).trim()
      );
      await interaction.editReply({ content: `[${workerId}] ${message}` });
      return true;
    }
    const operation = interaction.options.getSubcommand();
    const payload = { guildId: interaction.guildId, requestedBy: interaction.user.id };
    if (operation === 'play' || operation === 'join') {
      payload.channelId = await targetVoice(interaction);
      if (!payload.channelId) {
        await interaction.editReply({ content: 'Join a voice channel first.' });
        return true;
      }
    }
    if (operation === 'play') payload.source = interaction.options.getString('source', true);
    if (operation === 'scrub') {
      payload.deltaSec = parseSignedDuration(interaction.options.getString('offset', true));
      if (payload.deltaSec === null) {
        await interaction.editReply({ content: 'Use a signed offset such as `+30s`, `-1m`, or `+10m`.' });
        return true;
      }
    }
    const result = await broker.request(operation, payload, workerId);
    await interaction.editReply({ content: `[${workerId}] ${result.message || (result.ok ? 'Done.' : 'Command failed.')}` });
    return true;
  } catch (error) {
    await interaction.editReply({ content: error.message || 'The streambot command failed.' });
    return true;
  }
}

async function handleButton(interaction, broker, allowedUserIds) {
  if (!interaction.isButton() || !interaction.customId.startsWith(`${BUTTON_PREFIX}|`)) return false;
  if (!allowed(interaction, allowedUserIds)) {
    await interaction.reply({ content: 'You are not allowed to control streambots.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const [, workerId, action] = interaction.customId.split('|');
  let operation = action;
  const payload = { guildId: interaction.guildId, requestedBy: interaction.user.id };
  if (action.startsWith('scrub:')) {
    operation = 'scrub';
    payload.deltaSec = Number(action.slice(6));
  }
  await interaction.deferUpdate();
  try {
    const result = await broker.request(operation, payload, workerId);
    await interaction.editReply({ content: playerText(workerId, result), components: playerComponents(workerId) });
  } catch (error) {
    await interaction.editReply({ content: `**Stream player — \`${workerId}\`**\n${error.message}`, components: playerComponents(workerId) });
  }
  return true;
}

module.exports = {
  STREAM_COMMAND,
  PLAYER_COMMAND,
  SET_STREAM_NAME_COMMAND,
  streamCommand,
  playerCommand,
  setStreamNameCommand,
  autocomplete,
  handleCommand,
  handleButton,
  playerComponents,
  playerText,
  setStreambotNickname
};
