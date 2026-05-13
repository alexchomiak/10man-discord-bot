const {
  ActionRowBuilder,
  ChannelType,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags
} = require('discord.js');
const { COMMANDS } = require('./commands.ts');
const { SPEECH } = require('./speech.ts');
const { DISCORD_MESSAGES } = require('./messages.ts');

const DRAFT_EMBED_COLOR = 0xf1c40f;

function draftStatusIcon(status, isComplete = false) {
  if (isComplete) {
    return '✅';
  }

  const normalized = String(status || '').toLowerCase();
  if (normalized.includes('draft')) {
    return '🟢';
  }
  if (normalized.includes('wait')) {
    return '🕒';
  }
  if (normalized.includes('ready')) {
    return '🏁';
  }
  if (normalized.includes('active')) {
    return '⚔️';
  }
  return '🧩';
}

function numberedList(items, formatter) {
  if (!items.length) {
    return 'None';
  }

  return items.map((item, index) => formatter(item, index)).join('\n');
}

function truncateEmbedField(value, maxLength = 1024) {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 24).trimEnd()}\n… and more`;
}

const DEFAULT_TEAM_NAMES = [
  'Mirage',
  'Inferno',
  'Nuke',
  'Ancient',
  'Vertigo',
  'Anubis',
  'Dust2',
  'Train'
];

function getTeamNamePool(config) {
  return config.teamNames?.length >= 2 ? config.teamNames : DEFAULT_TEAM_NAMES;
}

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function shuffle(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function formatMentions(userIds, formatUser = (id) => `<@${id}>`) {
  return userIds.map((id) => formatUser(id)).join(', ');
}

function formatDraftPickHistory(history = []) {
  if (!history.length) {
    return 'No picks made yet.';
  }

  return truncateEmbedField(history.map((entry, index) => `${index + 1}. ${entry}`).join('\n'));
}

function normalizeDraftMode(mode) {
  return mode === 'regular' ? 'regular' : 'snake';
}

function formatDraftMode(mode) {
  return normalizeDraftMode(mode) === 'regular' ? 'Regular' : 'Snake';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForNarrationThenPause(audioManager, guild, captainName, pickedNames, nextCaptainName, pauseMs = 3_000) {
  if (audioManager && guild) {
    await audioManager.announcePicks(guild, captainName, Array.isArray(pickedNames) ? pickedNames : [pickedNames], nextCaptainName).catch(() => false);
  }
  await sleep(pauseMs);
}

function draftChatName(channel) {
  return channel?.name || SPEECH.DEFAULT_DRAFT_CHAT_NAME;
}

async function playDraftIntro(audioManager, guildId, captainAName, teamNameA, captainBName, teamNameB, channel) {
  if (!audioManager || !guildId) {
    return;
  }

  await sleep(2_000);
  await audioManager.speak(
    guildId,
    SPEECH.draftIntro({ captainAName, teamNameA, captainBName, teamNameB, draftChatName: draftChatName(channel) })
  ).catch(() => false);
}

async function playCountdownThenAnnounceMatchup(audioManager, guildId, teamNameA, teamNameB, channel) {
  if (!audioManager || !guildId) {
    return;
  }

  audioManager.playFinalCountdown(guildId);
  await sleep(5_000);
  await audioManager.speak(
    guildId,
    SPEECH.matchupReady({ teamNameA, teamNameB, draftChatName: draftChatName(channel) })
  ).catch(() => false);
}

async function playFightThenPause(audioManager, guildId, pauseMs = 1_000) {
  if (audioManager && guildId) {
    await audioManager.playFight(guildId).catch((error) => {
      console.error('Failed to play fight start audio:', error);
      return false;
    });
  }
  await sleep(pauseMs);
}

function createSnakeOrder(totalPicks, firstCaptainId, secondCaptainId) {
  if (totalPicks <= 0) {
    return [];
  }

  const order = [firstCaptainId];
  let current = secondCaptainId;

  while (order.length < totalPicks) {
    order.push(current);
    if (order.length < totalPicks) {
      order.push(current);
    }
    current = current === firstCaptainId ? secondCaptainId : firstCaptainId;
  }

  return order;
}

function createRegularOrder(totalPicks, firstCaptainId, secondCaptainId) {
  return Array.from({ length: totalPicks }, (_, index) => (index % 2 === 0 ? firstCaptainId : secondCaptainId));
}

function createDraftOrder(totalPicks, firstCaptainId, secondCaptainId, draftMode = 'snake') {
  return normalizeDraftMode(draftMode) === 'regular'
    ? createRegularOrder(totalPicks, firstCaptainId, secondCaptainId)
    : createSnakeOrder(totalPicks, firstCaptainId, secondCaptainId);
}

class DraftManager {
  constructor(audioManager = null, playerManager = null) {
    this.audioManager = audioManager;
    this.playerManager = playerManager;
    this.sessionsByGuild = new Map();
    this.sessionsById = new Map();
    this.mockVoiceByGuild = new Map();
    this.mockAudioSessionsById = new Map();
  }

  getSessionByGuild(guildId) {
    return this.sessionsByGuild.get(guildId);
  }

  getSessionById(sessionId) {
    return this.sessionsById.get(sessionId);
  }

  async resolveGuild(interaction) {
    if (interaction.guild) {
      return interaction.guild;
    }

    if (interaction.guildId) {
      return interaction.client.guilds.fetch(interaction.guildId).catch(() => null);
    }

    return null;
  }

  async startDraft(interaction, config) {
    const guild = await this.resolveGuild(interaction);
    if (!guild) {
      await interaction.reply({ content: DISCORD_MESSAGES.SERVER_ONLY, flags: MessageFlags.Ephemeral });
      return;
    }

    if (this.sessionsByGuild.has(guild.id)) {
      await interaction.reply({
        content: DISCORD_MESSAGES.draftAlreadyActive,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const member = await guild.members.fetch(interaction.user.id);
    const sourceVoice = member.voice?.channel;
    if (!sourceVoice || sourceVoice.type !== ChannelType.GuildVoice) {
      await interaction.reply({
        content: DISCORD_MESSAGES.needVoiceForDraft(COMMANDS.TEAM_DRAFT.name),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const players = sourceVoice.members.filter((m) => !m.user.bot);
    if (players.size < config.minPlayers) {
      await interaction.reply({
        content: DISCORD_MESSAGES.needMinVoicePlayers(config.minPlayers),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const requestedPlayers = interaction.options?.getInteger(COMMANDS.TEAM_DRAFT.options.PLAYERS.name);
    const requestedCaptain1 = interaction.options?.getUser(COMMANDS.TEAM_DRAFT.options.CAPTAIN_1.name);
    const requestedCaptain2 = interaction.options?.getUser(COMMANDS.TEAM_DRAFT.options.CAPTAIN_2.name);
    const draftMode = normalizeDraftMode(interaction.options?.getString(COMMANDS.TEAM_DRAFT.options.DRAFT_TYPE.name));
    const refreshRatings = interaction.options?.getBoolean(COMMANDS.TEAM_DRAFT.options.REFRESH_RATINGS.name) ?? false;
    let ratingsRefreshSummary = null;
    let draftPlayerCount = players.size;

    if ((requestedCaptain1 && !requestedCaptain2) || (!requestedCaptain1 && requestedCaptain2)) {
      await interaction.reply({
        content: DISCORD_MESSAGES.missingBothCaptains(COMMANDS.TEAM_DRAFT.options.CAPTAIN_1.name, COMMANDS.TEAM_DRAFT.options.CAPTAIN_2.name),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (requestedPlayers !== null && requestedPlayers !== undefined) {
      if (requestedPlayers < config.minPlayers) {
        await interaction.reply({
          content: DISCORD_MESSAGES.minDraftPlayersOption(COMMANDS.TEAM_DRAFT.options.PLAYERS.name, config.minPlayers),
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      if (requestedPlayers > players.size) {
        await interaction.reply({
          content: DISCORD_MESSAGES.tooManyDraftPlayersOption(COMMANDS.TEAM_DRAFT.options.PLAYERS.name, players.size),
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      draftPlayerCount = requestedPlayers;
    }

    if (draftPlayerCount % 2 !== 0) {
      await interaction.reply({
        content: DISCORD_MESSAGES.draftPlayerCountEven(draftPlayerCount),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (draftPlayerCount < config.minPlayers) {
      await interaction.reply({
        content: DISCORD_MESSAGES.needMinDraftablePlayers(config.minPlayers),
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const playerIds = shuffle([...players.keys()]);
    let captainA = playerIds[0];
    let captainB = playerIds[1];

    if (requestedCaptain1 && requestedCaptain2) {
      if (requestedCaptain1.id === requestedCaptain2.id) {
        await interaction.reply({ content: DISCORD_MESSAGES.captainsMustDiffer, flags: MessageFlags.Ephemeral });
        return;
      }

      if (!players.has(requestedCaptain1.id) || !players.has(requestedCaptain2.id)) {
        await interaction.reply({
          content: DISCORD_MESSAGES.captainsMustShareVoice,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      captainA = requestedCaptain1.id;
      captainB = requestedCaptain2.id;
    }

    if (refreshRatings && this.playerManager) {
      await interaction.deferReply();
      const refreshResult = await this.playerManager.refreshRatingsForMembers(players).catch((error) => {
        console.error('Failed to refresh ratings before draft:', error);
        return null;
      });
      if (refreshResult) {
        ratingsRefreshSummary = `Refreshed Premier ratings for ${refreshResult.updated}/${refreshResult.total} linked players${refreshResult.failed ? ` (${refreshResult.failed} failed)` : ''}.`;
      }
    }

    const pool = playerIds.filter((id) => id !== captainA && id !== captainB);
    const [teamNameA, teamNameB] = shuffle(getTeamNamePool(config)).slice(0, 2);
    const teamSize = draftPlayerCount / 2;
    const picksNeeded = draftPlayerCount - 2;
    const pickOrder = createDraftOrder(picksNeeded, captainA, captainB, draftMode);

    const sessionId = `${guild.id}-${Date.now()}`;
    const session = {
      id: sessionId,
      guildId: guild.id,
      sourceVoiceId: sourceVoice.id,
      textChannelId: interaction.channelId,
      readyMessageId: null,
      captains: [captainA, captainB],
      teamA: [captainA],
      teamB: [captainB],
      pool,
      pickOrder,
      pickIndex: 0,
      draftMode,
      pendingPickAnnouncement: null,
      draftHistory: [],
      teamSize,
      resources: {
        roleAId: null,
        roleBId: null,
        channelAId: null,
        channelBId: null
      },
      matchupNames: { teamNameA, teamNameB },
      status: 'drafting'
    };

    this.sessionsByGuild.set(guild.id, session);
    this.sessionsById.set(session.id, session);

    const replyPayload = {
      embeds: [this.buildDraftEmbed(session, guild)],
      components: [this.buildPickMenu(session, guild)],
      fetchReply: true
    };
    const reply = interaction.deferred
      ? await interaction.editReply(replyPayload)
      : await interaction.reply(replyPayload);

    session.messageId = reply.id;

    if (ratingsRefreshSummary) {
      await interaction.followUp({ content: ratingsRefreshSummary, flags: MessageFlags.Ephemeral }).catch(() => {});
    }

    if (this.audioManager) {
      this.audioManager.join(sourceVoice)
        .then(() => playDraftIntro(
          this.audioManager,
          guild.id,
          sourceVoice.members.get(captainA)?.displayName || 'Captain 1',
          teamNameA,
          sourceVoice.members.get(captainB)?.displayName || 'Captain 2',
          teamNameB,
          interaction.channel
        ))
        .catch((error) => {
          console.error('Failed to join draft voice channel for audio:', error);
        });
    }
  }

  async runMockDraft(interaction, requestedPlayers, config, spawnVoice, broadcast, requestedDraftMode = 'snake') {
    const totalPlayers = Number.parseInt(requestedPlayers, 10);
    const draftMode = normalizeDraftMode(requestedDraftMode);
    if (Number.isNaN(totalPlayers)) {
      await interaction.reply({ content: DISCORD_MESSAGES.mockPlayerCountNumber, flags: MessageFlags.Ephemeral });
      return;
    }

    if (totalPlayers < 4) {
      await interaction.reply({ content: DISCORD_MESSAGES.mockMinPlayers, flags: MessageFlags.Ephemeral });
      return;
    }

    if (totalPlayers % 2 !== 0) {
      await interaction.reply({ content: DISCORD_MESSAGES.mockEvenPlayers, flags: MessageFlags.Ephemeral });
      return;
    }

    const guild = await this.resolveGuild(interaction);
    const member = guild ? await guild.members.fetch(interaction.user.id).catch(() => null) : null;
    const voiceChannel = member?.voice?.channel;

    const fakePlayers = Array.from({ length: totalPlayers }, (_, idx) => `Player${idx + 1}`);
    const shuffled = shuffle(fakePlayers);
    const [captainA, captainB, ...pool] = shuffled;
    const teamA = [captainA];
    const teamB = [captainB];
    const pickOrder = createDraftOrder(pool.length, captainA, captainB, draftMode);
    const [teamNameA, teamNameB] = shuffle(getTeamNamePool(config)).slice(0, 2);
    const formatMockPlayer = (name) => `**${name}**`;
    const draftHistory = [];
    const buildMockSession = () => ({
      captains: [captainA, captainB],
      teamA,
      teamB,
      pool,
      pickOrder,
      pickIndex: teamA.length + teamB.length - 2,
      draftMode,
      draftHistory,
      teamSize: totalPlayers / 2,
      matchupNames: { teamNameA, teamNameB }
    });

    const reply = await interaction.reply({
      embeds: [
        this.buildDraftEmbed(buildMockSession(), guild, {
          status: 'Draft starting',
          formatUser: formatMockPlayer
        })
      ],
      ...(broadcast ? {} : { flags: MessageFlags.Ephemeral }),
      fetchReply: true
    });

    if (this.audioManager && voiceChannel) {
      await this.audioManager.join(voiceChannel)
        .then(() => playDraftIntro(this.audioManager, guild.id, captainA, teamNameA, captainB, teamNameB, interaction.channel))
        .catch((error) => {
          console.error('Failed to join mock draft voice channel for audio:', error);
        });
    }

    await sleep(3_000);

    const applyMockPick = (picker) => {
      const pickIndex = randomInt(pool.length);
      const picked = pool.splice(pickIndex, 1)[0];
      if (picker === captainA) {
        teamA.push(picked);
      } else {
        teamB.push(picked);
      }
      return picked;
    };

    const editMockReply = async () => {
      await reply.edit({
        embeds: [
          this.buildDraftEmbed(buildMockSession(), guild, {
            status: pool.length > 0 ? 'Drafting' : 'Complete',
            formatUser: formatMockPlayer
          })
        ]
      }).catch(() => {});
    };

    let pendingNarration = null;
    for (let pickCursor = 0; pickCursor < pickOrder.length; pickCursor += 1) {
      const picker = pickOrder[pickCursor];
      const picked = applyMockPick(picker);
      const nextPicker = pickOrder[pickCursor + 1];
      const hasBackToBackSnakePick = draftMode === 'snake' && nextPicker === picker;
      const narrationPickedNames = pendingNarration?.picker === picker
        ? [...pendingNarration.pickedNames, picked]
        : [picked];
      const shouldNarrate = !hasBackToBackSnakePick;

      draftHistory.push(nextPicker
        ? `🧪 ${formatMockPlayer(picker)} drafted ${formatMockPlayer(picked)}. Next pick: ${formatMockPlayer(nextPicker)}`
        : `🧪 ${formatMockPlayer(picker)} drafted ${formatMockPlayer(picked)}. Mock draft picks complete.`);

      await editMockReply();

      if (shouldNarrate) {
        await waitForNarrationThenPause(this.audioManager, guild, picker, narrationPickedNames, nextPicker);
        pendingNarration = null;
      } else {
        pendingNarration = { picker, pickedNames: narrationPickedNames };
      }
    }

    await playCountdownThenAnnounceMatchup(this.audioManager, guild?.id, teamNameA, teamNameB, interaction.channel);

    const mockSessionId = `${guild?.id || interaction.id}-mock-${Date.now()}`;
    if (guild) {
      this.mockAudioSessionsById.set(mockSessionId, { guildId: guild.id, status: 'ready', spawnVoice, config });
    }

    await reply.edit({
      embeds: [
        this.buildDraftEmbed(buildMockSession(), guild, {
          status: guild ? 'Ready to start' : 'Complete',
          formatUser: formatMockPlayer
        })
      ],
      components: guild ? [this.buildMockStartButton(mockSessionId)] : []
    }).catch(() => {});

  }

  async spawnMockVoice(interaction, config) {
    const guild = await this.resolveGuild(interaction);
    if (!guild) {
      await interaction.followUp({
        content: DISCORD_MESSAGES.mockServerContext(COMMANDS.TEAM_DRAFT_MOCK.name),
        flags: MessageFlags.Ephemeral
      }).catch(() => {});
      return;
    }

    if (this.mockVoiceByGuild.has(guild.id)) {
      await interaction.followUp({
        content: DISCORD_MESSAGES.mockVoiceAlreadyExists,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const member = await guild.members.fetch(interaction.user.id);
    const suffix = String(Date.now()).slice(-4);
    const role = await guild.roles.create({ name: `draft-mock-${suffix}`, mentionable: false, hoist: false });

    const voiceChannel = await guild.channels.create({
      name: '🧪 Mock Draft Test',
      type: ChannelType.GuildVoice,
      parent: config.teamCategoryId || null,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
        },
        {
          id: guild.members.me.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.MoveMembers,
            PermissionFlagsBits.ManageChannels
          ]
        },
        {
          id: role.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
        }
      ]
    });

    await member.roles.add(role);

    if (member.voice?.channelId) {
      await member.voice.setChannel(voiceChannel);
      await interaction.followUp({
        content: DISCORD_MESSAGES.mockVoiceCreatedAndMoved(voiceChannel),
        flags: MessageFlags.Ephemeral
      }).catch(() => {});
    } else {
      await interaction.followUp({
        content: DISCORD_MESSAGES.mockVoiceCreated(voiceChannel),
        flags: MessageFlags.Ephemeral
      }).catch(() => {});
    }

    this.mockVoiceByGuild.set(guild.id, {
      channelId: voiceChannel.id,
      roleId: role.id,
      memberId: member.id
    });
  }

  buildDraftRoster(userIds, formatUser = (id) => `<@${id}>`) {
    return truncateEmbedField(numberedList(userIds, (userId, index) => {
      const captainBadge = index === 0 ? '👑 ' : '';
      return `${index + 1}. ${captainBadge}${formatUser(userId)}`;
    }));
  }

  buildDraftEmbed(session, guild, options = {}) {
    const isComplete = session.pickIndex >= session.pickOrder.length;
    const currentCaptain = !isComplete ? session.pickOrder[session.pickIndex] : null;
    const title = isComplete ? '✅ Team Draft Complete' : '🧩 Team Draft';
    const status = options.status || (isComplete ? 'Complete' : 'Waiting for pick');
    const statusIcon = draftStatusIcon(status, isComplete);
    const { teamNameA = 'Alpha', teamNameB = 'Bravo' } = session.matchupNames || {};
    const totalPicks = session.pickOrder.length;
    const formatUser = options.formatUser || ((id) => `<@${id}>`);
    const normalizedStatus = String(status).toLowerCase();
    const descriptionLines = [
      `${statusIcon} **Status:** ${status}`,
      `👑 **Captains:** ${formatUser(session.captains[0])} vs ${formatUser(session.captains[1])}`,
      `👥 **Team size:** **${session.teamSize}v${session.teamSize}** · 🐍 **Draft:** **${formatDraftMode(session.draftMode)}**`,
      currentCaptain ? `🎯 **Current pick:** ${formatUser(currentCaptain)}` : '🎯 **Current pick:** none'
    ];

    if (isComplete) {
      descriptionLines.push(`🏁 **Matchup:** **${teamNameA}** vs **${teamNameB}**`);
    }
    if (normalizedStatus.includes('ready')) {
      descriptionLines.push('✅ Press **Start** to create team channels, or **Cancel** to abort.');
    }
    if (normalizedStatus.includes('active')) {
      descriptionLines.push('🔒 Teams have been moved to temporary private voice channels.');
    }

    return new EmbedBuilder()
      .setTitle(title)
      .setColor(DRAFT_EMBED_COLOR)
      .setDescription(descriptionLines.join('\n'))
      .addFields(
        { name: `🟦 ${teamNameA}`, value: this.buildDraftRoster(session.teamA, formatUser), inline: false },
        { name: `🟥 ${teamNameB}`, value: this.buildDraftRoster(session.teamB, formatUser), inline: false },
        {
          name: '🕹️ Undrafted',
          value: session.pool.length > 0 ? truncateEmbedField(formatMentions(session.pool, formatUser)) : 'No players left in the call.',
          inline: false
        },
        {
          name: '📜 Draft History',
          value: formatDraftPickHistory(session.draftHistory),
          inline: false
        }
      )
      .setFooter({ text: `${formatDraftMode(session.draftMode)} draft · ${session.pickIndex}/${totalPicks} picks made` })
      .setTimestamp();
  }

  buildPickMenu(session, guild) {
    const options = session.pool.map((userId) => {
      const member = guild.members.cache.get(userId);
      const label = this.playerManager?.formatMemberLabel(member) || member?.displayName || userId;
      return {
        label: label.slice(0, 100),
        value: userId
      };
    });

    return new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`draftpick:${session.id}`)
        .setPlaceholder('Captain selects next player')
        .setMinValues(1)
        .setMaxValues(1)
        .setDisabled(session.pool.length === 0)
        .addOptions(options.length > 0 ? options : [{ label: 'No players left', value: 'none' }])
    );
  }

  buildStartButtons(sessionId) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`draftstart:${sessionId}`)
        .setLabel('Start')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`draftabort:${sessionId}`)
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger)
    );
  }

  buildMockStartButton(sessionId) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`mockstart:${sessionId}`)
        .setLabel('Start Mock Match')
        .setStyle(ButtonStyle.Success)
    );
  }

  async handlePick(interaction, config) {
    const [, sessionId] = interaction.customId.split(':');
    const session = this.getSessionById(sessionId);

    if (!session) {
      await interaction.reply({ content: DISCORD_MESSAGES.draftSessionMissing, flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.user.id !== session.pickOrder[session.pickIndex]) {
      await interaction.reply({ content: DISCORD_MESSAGES.notYourPickTurn, flags: MessageFlags.Ephemeral });
      return;
    }

    const pickedId = interaction.values[0];
    if (!session.pool.includes(pickedId)) {
      await interaction.reply({ content: DISCORD_MESSAGES.playerNoLongerAvailable, flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferUpdate();

    session.pool = session.pool.filter((id) => id !== pickedId);

    if (interaction.user.id === session.captains[0]) {
      session.teamA.push(pickedId);
    } else {
      session.teamB.push(pickedId);
    }

    session.pickIndex += 1;

    const nextCaptain = session.pickOrder[session.pickIndex];
    session.draftHistory.push(nextCaptain
      ? `🧩 <@${interaction.user.id}> drafted <@${pickedId}>. Next pick: <@${nextCaptain}>`
      : `🧩 <@${interaction.user.id}> drafted <@${pickedId}>. Draft picks complete.`);

    const pickerName = interaction.member?.displayName || interaction.user.displayName || interaction.user.username;
    const pickedName = interaction.guild.members.cache.get(pickedId)?.displayName || 'the pick';
    const nextCaptainName = nextCaptain ? interaction.guild.members.cache.get(nextCaptain)?.displayName : null;
    const hasBackToBackSnakePick = session.draftMode === 'snake' && nextCaptain === interaction.user.id;
    const pendingAnnouncement = session.pendingPickAnnouncement;
    let announcementCaptainName = pickerName;
    let announcementPickedNames = [pickedName];
    let shouldAnnouncePick = true;

    if (pendingAnnouncement?.captainId === interaction.user.id) {
      announcementCaptainName = pendingAnnouncement.captainName;
      announcementPickedNames = [...pendingAnnouncement.pickedNames, pickedName];
      session.pendingPickAnnouncement = null;
    } else if (hasBackToBackSnakePick) {
      session.pendingPickAnnouncement = {
        captainId: interaction.user.id,
        captainName: pickerName,
        pickedNames: [pickedName]
      };
      shouldAnnouncePick = false;
    } else {
      session.pendingPickAnnouncement = null;
    }

    const draftMessage = interaction.message || (session.messageId
      ? await interaction.channel.messages.fetch(session.messageId).catch(() => null)
      : null);

    if (draftMessage) {
      session.messageId = draftMessage.id;
      if (shouldAnnouncePick) {
        await draftMessage.edit({
          embeds: [this.buildDraftEmbed(session, interaction.guild, { status: 'Drafting' })],
          components: []
        }).catch(() => {});
      }
    }

    if (this.audioManager && shouldAnnouncePick) {
      await this.audioManager.announcePicks(interaction.guild, announcementCaptainName, announcementPickedNames, nextCaptainName).catch((error) => {
        console.error('Failed to announce draft pick in voice:', error);
        return false;
      });
    }

    if (session.pickIndex < session.pickOrder.length) {
      if (draftMessage) {
        await draftMessage.edit({
          embeds: [this.buildDraftEmbed(session, interaction.guild)],
          components: [this.buildPickMenu(session, interaction.guild)]
        }).catch(() => {});
      } else {
        const newMessage = await interaction.channel.send({
          embeds: [this.buildDraftEmbed(session, interaction.guild)],
          components: [this.buildPickMenu(session, interaction.guild)]
        });
        session.messageId = newMessage.id;
      }
      return;
    }

    if (draftMessage) {
      await draftMessage.edit({
        embeds: [this.buildDraftEmbed(session, interaction.guild)],
        components: []
      }).catch(() => {});
    }

    const { teamNameA, teamNameB } = session.matchupNames || (() => {
      const [fallbackTeamNameA, fallbackTeamNameB] = shuffle(getTeamNamePool(config)).slice(0, 2);
      return { teamNameA: fallbackTeamNameA, teamNameB: fallbackTeamNameB };
    })();
    session.matchupNames = { teamNameA, teamNameB };
    await this.markReadyToStart(interaction, session);
  }

  async markReadyToStart(interaction, session) {
    session.status = 'ready';
    const draftMessage = interaction.message || (session.messageId
      ? await interaction.channel.messages.fetch(session.messageId).catch(() => null)
      : null);

    if (draftMessage) {
      session.messageId = draftMessage.id;
      session.readyMessageId = draftMessage.id;
      await draftMessage.edit({
        embeds: [this.buildDraftEmbed(session, interaction.guild, { status: 'Ready to start' })],
        components: [this.buildStartButtons(session.id)]
      }).catch(() => {});
    }

    if (session.matchupNames) {
      await playCountdownThenAnnounceMatchup(
        this.audioManager,
        interaction.guild.id,
        session.matchupNames.teamNameA,
        session.matchupNames.teamNameB,
        interaction.channel
      );
    }
  }

  async finalizeDraft(interaction, session, config) {
    const guild = interaction.guild;
    const [nameA, nameB] = session.matchupNames
      ? [session.matchupNames.teamNameA, session.matchupNames.teamNameB]
      : shuffle(getTeamNamePool(config)).slice(0, 2);
    session.matchupNames = { teamNameA: nameA, teamNameB: nameB };
    const suffix = session.id.slice(-4);

    let roleA = null;
    let roleB = null;
    let channelA = null;
    let channelB = null;

    try {
      roleA = await guild.roles.create({ name: `draft-${suffix}-alpha`, mentionable: false, hoist: false });
      roleB = await guild.roles.create({ name: `draft-${suffix}-bravo`, mentionable: false, hoist: false });

      session.resources.roleAId = roleA.id;
      session.resources.roleBId = roleB.id;

    const baseOverwrites = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]
      },
      {
        id: guild.members.me.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.Connect,
          PermissionFlagsBits.MoveMembers,
          PermissionFlagsBits.ManageChannels
        ]
      }
    ];

      channelA = await guild.channels.create({
        name: `🔵 ${nameA}`,
        type: ChannelType.GuildVoice,
        parent: config.teamCategoryId || null,
        permissionOverwrites: [
          ...baseOverwrites,
          { id: roleA.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] }
        ]
      });

      channelB = await guild.channels.create({
        name: `🔴 ${nameB}`,
        type: ChannelType.GuildVoice,
        parent: config.teamCategoryId || null,
        permissionOverwrites: [
          ...baseOverwrites,
          { id: roleB.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] }
        ]
      });

      session.resources.channelAId = channelA.id;
      session.resources.channelBId = channelB.id;

      await Promise.all([
        ...session.teamA.map(async (userId) => {
          const guildMember = await guild.members.fetch(userId);
          await guildMember.roles.add(roleA);
          if (guildMember.voice.channelId) {
            await guildMember.voice.setChannel(channelA);
          }
        }),
        ...session.teamB.map(async (userId) => {
          const guildMember = await guild.members.fetch(userId);
          await guildMember.roles.add(roleB);
          if (guildMember.voice.channelId) {
            await guildMember.voice.setChannel(channelB);
          }
        })
      ]);
      session.status = 'active';

      await interaction.editReply({
        embeds: [this.buildDraftEmbed(session, guild, { status: 'Active — teams moved to private voice channels' })],
        components: []
      });
      this.audioManager?.stop(guild.id);
    } catch (error) {
      if (channelA) {
        await channelA.delete('Draft start failed during setup').catch(() => {});
      }
      if (channelB) {
        await channelB.delete('Draft start failed during setup').catch(() => {});
      }
      if (roleA) {
        await roleA.delete('Draft start failed during setup').catch(() => {});
      }
      if (roleB) {
        await roleB.delete('Draft start failed during setup').catch(() => {});
      }

      session.resources.roleAId = null;
      session.resources.roleBId = null;
      session.resources.channelAId = null;
      session.resources.channelBId = null;
      session.status = 'ready';

      await interaction.editReply({ content: DISCORD_MESSAGES.draftResourceStartFailed, components: [] }).catch(() => {});
      throw error;
    }
  }


  async handleMockStartButton(interaction) {
    const [, sessionId] = interaction.customId.split(':');
    const session = this.mockAudioSessionsById.get(sessionId);
    if (!session) {
      await interaction.reply({ content: DISCORD_MESSAGES.mockAudioSessionMissing, flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferUpdate();
    await playFightThenPause(this.audioManager, session.guildId);
    if (this.audioManager) {
      setTimeout(() => this.audioManager.stop(session.guildId), 3_000);
    }
    if (session.spawnVoice) {
      await this.spawnMockVoice(interaction, session.config);
    }
    this.mockAudioSessionsById.delete(sessionId);
    await interaction.message.edit({ components: [] }).catch(() => {});
  }

  async handleStartDraftButton(interaction, config) {
    const [, sessionId] = interaction.customId.split(':');
    const session = this.getSessionById(sessionId);
    if (!session) {
      await interaction.reply({ content: DISCORD_MESSAGES.draftSessionMissing, flags: MessageFlags.Ephemeral });
      return;
    }
    if (session.status !== 'ready') {
      await interaction.reply({ content: DISCORD_MESSAGES.draftNotReady, flags: MessageFlags.Ephemeral });
      return;
    }
    session.status = 'starting';
    await interaction.deferUpdate();
    await interaction.editReply({
      embeds: [this.buildDraftEmbed(session, interaction.guild, { status: 'Starting team channels' })],
      components: []
    }).catch(() => {});
    await playFightThenPause(this.audioManager, interaction.guild.id);
    await this.finalizeDraft(interaction, session, config);
    if (this.audioManager) {
      setTimeout(() => this.audioManager.stop(interaction.guild.id), 3_000);
    }
  }

  async handleAbortDraftButton(interaction) {
    const [, sessionId] = interaction.customId.split(':');
    const session = this.getSessionById(sessionId);
    if (!session) {
      await interaction.reply({ content: DISCORD_MESSAGES.draftSessionMissing, flags: MessageFlags.Ephemeral });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: DISCORD_MESSAGES.SERVER_ONLY, flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferUpdate();
    await interaction.editReply({
      embeds: [this.buildDraftEmbed(session, guild, { status: 'Cancelled' })],
      components: []
    }).catch(() => {});
    await this.cleanupSession(guild, session);
  }

  async handleVoiceStateUpdate(oldState, newState) {
    const guildId = oldState.guild.id;
    const mockSession = this.mockVoiceByGuild.get(guildId);
    if (mockSession && oldState.channelId === mockSession.channelId) {
      const mockChannel = oldState.guild.channels.cache.get(mockSession.channelId);
      if (mockChannel && mockChannel.members.size === 0) {
        await this.cleanupMockSession(oldState.guild, mockSession);
      }
    }

    const session = this.sessionsByGuild.get(guildId);
    if (!session) {
      return;
    }

    const watchedChannelIds = [session.resources.channelAId, session.resources.channelBId].filter(Boolean);
    if (!watchedChannelIds.includes(oldState.channelId)) {
      return;
    }

    const oldChannel = oldState.guild.channels.cache.get(oldState.channelId);
    if (oldChannel && oldChannel.members.size === 0) {
      try {
        await oldChannel.delete('Temporary draft team channel is empty');
      } catch (_error) {
        // Channel may already be deleted manually.
      }
    }

    const chAExists = oldState.guild.channels.cache.has(session.resources.channelAId);
    const chBExists = oldState.guild.channels.cache.has(session.resources.channelBId);

    if (!chAExists && !chBExists) {
      await this.cleanupSession(oldState.guild, session);
    }
  }

  async cleanupSession(guild, session) {
    const roleA = guild.roles.cache.get(session.resources.roleAId);
    const roleB = guild.roles.cache.get(session.resources.roleBId);

    for (const userId of [...session.teamA, ...session.teamB]) {
      try {
        const member = await guild.members.fetch(userId);
        if (roleA && member.roles.cache.has(roleA.id)) {
          await member.roles.remove(roleA);
        }
        if (roleB && member.roles.cache.has(roleB.id)) {
          await member.roles.remove(roleB);
        }
      } catch (_error) {
        // Member may have left guild.
      }
    }

    if (roleA) {
      await roleA.delete('Draft finished').catch(() => {});
    }
    if (roleB) {
      await roleB.delete('Draft finished').catch(() => {});
    }

    this.audioManager?.stop(guild.id);
    this.sessionsByGuild.delete(session.guildId);
    this.sessionsById.delete(session.id);
  }

  async cleanupMockSession(guild, mockSession) {
    const mockChannel = guild.channels.cache.get(mockSession.channelId);
    if (mockChannel) {
      await mockChannel.delete('Temporary mock voice channel is empty').catch(() => {});
    }

    const role = guild.roles.cache.get(mockSession.roleId);
    if (role) {
      const holder = await guild.members.fetch(mockSession.memberId).catch(() => null);
      if (holder && holder.roles.cache.has(role.id)) {
        await holder.roles.remove(role).catch(() => {});
      }
      await role.delete('Mock draft cleanup').catch(() => {});
    }

    this.mockVoiceByGuild.delete(guild.id);
  }

  async clearDraftMessageComponents(guild, session) {
    const channel = guild.channels.cache.get(session.textChannelId);
    if (!channel || !('messages' in channel)) {
      return;
    }

    for (const messageId of [session.messageId, session.readyMessageId]) {
      if (!messageId) {
        continue;
      }
      const message = await channel.messages.fetch(messageId).catch(() => null);
      if (message) {
        await message.edit({ components: [] }).catch(() => {});
      }
    }
  }

  async getDraftStatus(interaction) {
    const guild = await this.resolveGuild(interaction);
    if (!guild) {
      await interaction.reply({ content: DISCORD_MESSAGES.SERVER_ONLY, flags: MessageFlags.Ephemeral });
      return;
    }

    const session = this.sessionsByGuild.get(guild.id);
    const mockSession = this.mockVoiceByGuild.get(guild.id);

    if (!session && !mockSession) {
      await interaction.reply({ content: DISCORD_MESSAGES.noActiveDraftOrMock, flags: MessageFlags.Ephemeral });
      return;
    }

    const lines = [];
    if (session) {
      lines.push(`Active draft session: \`${session.id}\``);
      lines.push(`Team size: ${session.teamSize}v${session.teamSize}`);
      lines.push(`Draft type: ${formatDraftMode(session.draftMode)}`);
      lines.push(`Drafted players: ${session.teamA.length + session.teamB.length}/${session.teamSize * 2}`);
      lines.push(`Channels created: ${session.resources.channelAId ? 'yes' : 'no'}`);
      lines.push(`Status: ${session.status}`);
    }
    if (mockSession) {
      lines.push(`Mock voice channel active: <#${mockSession.channelId}>`);
    }

    await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral });
  }

  async cancelDraft(interaction) {
    const guild = await this.resolveGuild(interaction);
    if (!guild) {
      await interaction.reply({ content: DISCORD_MESSAGES.SERVER_ONLY, flags: MessageFlags.Ephemeral });
      return;
    }

    const session = this.sessionsByGuild.get(guild.id);
    if (!session) {
      await interaction.reply({ content: DISCORD_MESSAGES.noActiveDraftToCancel, flags: MessageFlags.Ephemeral });
      return;
    }

    await this.clearDraftMessageComponents(guild, session);

    for (const channelId of [session.resources.channelAId, session.resources.channelBId]) {
      if (!channelId) {
        continue;
      }
      const channel = guild.channels.cache.get(channelId);
      if (channel) {
        await channel.delete('Draft cancelled').catch(() => {});
      }
    }

    await this.cleanupSession(guild, session);
    await interaction.reply({ content: DISCORD_MESSAGES.draftCancelled });
  }

  async cleanupDraft(interaction) {
    const guild = await this.resolveGuild(interaction);
    if (!guild) {
      await interaction.reply({ content: DISCORD_MESSAGES.SERVER_ONLY, flags: MessageFlags.Ephemeral });
      return;
    }

    const session = this.sessionsByGuild.get(guild.id);
    if (session) {
      await this.clearDraftMessageComponents(guild, session);
      for (const channelId of [session.resources.channelAId, session.resources.channelBId]) {
        if (!channelId) {
          continue;
        }
        const channel = guild.channels.cache.get(channelId);
        if (channel) {
          await channel.delete('Forced draft cleanup').catch(() => {});
        }
      }
      await this.cleanupSession(guild, session);
    }

    const mockSession = this.mockVoiceByGuild.get(guild.id);
    if (mockSession) {
      await this.cleanupMockSession(guild, mockSession);
    }

    if (!session && !mockSession) {
      await interaction.reply({ content: DISCORD_MESSAGES.noDraftResourcesToCleanup, flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply({ content: DISCORD_MESSAGES.forcedCleanupComplete, flags: MessageFlags.Ephemeral });
  }

  async returnToVoice(interaction) {
    const guild = await this.resolveGuild(interaction);
    if (!guild) {
      await interaction.reply({ content: DISCORD_MESSAGES.SERVER_ONLY, flags: MessageFlags.Ephemeral });
      return;
    }

    const session = this.sessionsByGuild.get(guild.id);
    if (!session) {
      await interaction.reply({ content: DISCORD_MESSAGES.noActiveDraft, flags: MessageFlags.Ephemeral });
      return;
    }

    const sourceChannel = guild.channels.cache.get(session.sourceVoiceId)
      || await guild.channels.fetch(session.sourceVoiceId).catch(() => null);
    if (!sourceChannel || sourceChannel.type !== ChannelType.GuildVoice) {
      await interaction.reply({
        content: DISCORD_MESSAGES.originalVoiceMissing,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const memberIds = new Set([...session.teamA, ...session.teamB]);
    for (const channelId of [session.resources.channelAId, session.resources.channelBId]) {
      if (!channelId) {
        continue;
      }
      const teamChannel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
      if (teamChannel && teamChannel.members) {
        for (const [memberId] of teamChannel.members) {
          memberIds.add(memberId);
        }
      }
    }

    await Promise.all(
      [...memberIds].map(async (userId) => {
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member && member.voice.channelId) {
          await member.voice.setChannel(sourceChannel).catch(() => {});
        }
      })
    );

    await this.clearDraftMessageComponents(guild, session);

    for (const channelId of [session.resources.channelAId, session.resources.channelBId]) {
      if (!channelId) {
        continue;
      }
      const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
      if (channel) {
        await channel.delete('Returning players to source voice').catch(() => {});
      }
    }

    await this.cleanupSession(guild, session);
    await interaction.reply({ content: DISCORD_MESSAGES.returnedPlayers(sourceChannel) });
  }
}

module.exports = {
  DraftManager
};
