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

function formatMentions(userIds) {
  return userIds.map((id) => `<@${id}>`).join(', ');
}

function formatNames(names) {
  return names.join(', ');
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

class DraftManager {
  constructor(audioManager = null) {
    this.audioManager = audioManager;
    this.sessionsByGuild = new Map();
    this.sessionsById = new Map();
    this.mockVoiceByGuild = new Map();
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
      await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (this.sessionsByGuild.has(guild.id)) {
      await interaction.reply({
        content: 'A draft is already active in this server. Finish or cancel it before starting another.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const member = await guild.members.fetch(interaction.user.id);
    const sourceVoice = member.voice?.channel;
    if (!sourceVoice || sourceVoice.type !== ChannelType.GuildVoice) {
      await interaction.reply({
        content: 'Join a voice channel first, then run `/team-draft`.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const players = sourceVoice.members.filter((m) => !m.user.bot);
    if (players.size < config.minPlayers) {
      await interaction.reply({
        content: `Need at least ${config.minPlayers} non-bot players in your voice channel.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const requestedPlayers = interaction.options?.getInteger('players');
    const requestedCaptain1 = interaction.options?.getUser('captain1');
    const requestedCaptain2 = interaction.options?.getUser('captain2');
    let draftPlayerCount = players.size;

    if ((requestedCaptain1 && !requestedCaptain2) || (!requestedCaptain1 && requestedCaptain2)) {
      await interaction.reply({
        content: 'If you set a captain manually, you must provide both `captain1` and `captain2`.',
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (requestedPlayers !== null && requestedPlayers !== undefined) {
      if (requestedPlayers < config.minPlayers) {
        await interaction.reply({
          content: `\`players\` must be at least ${config.minPlayers}.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      if (requestedPlayers > players.size) {
        await interaction.reply({
          content: `\`players\` cannot exceed players currently in voice (${players.size}).`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      draftPlayerCount = requestedPlayers;
    }

    if (draftPlayerCount % 2 !== 0) {
      await interaction.reply({
        content: `Draft player count must be even. You selected ${draftPlayerCount}.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (draftPlayerCount < config.minPlayers) {
      await interaction.reply({
        content: `Need at least ${config.minPlayers} draftable players.`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const playerIds = shuffle([...players.keys()]);
    let captainA = playerIds[0];
    let captainB = playerIds[1];

    if (requestedCaptain1 && requestedCaptain2) {
      if (requestedCaptain1.id === requestedCaptain2.id) {
        await interaction.reply({ content: 'Captain 1 and Captain 2 must be different users.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (!players.has(requestedCaptain1.id) || !players.has(requestedCaptain2.id)) {
        await interaction.reply({
          content: 'Both captains must be in the same voice channel as the command invoker.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      captainA = requestedCaptain1.id;
      captainB = requestedCaptain2.id;
    }

    const pool = playerIds.filter((id) => id !== captainA && id !== captainB);
    const teamSize = draftPlayerCount / 2;
    const picksNeeded = draftPlayerCount - 2;
    const pickOrder = createSnakeOrder(picksNeeded, captainA, captainB);

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
      teamSize,
      resources: {
        roleAId: null,
        roleBId: null,
        channelAId: null,
        channelBId: null
      },
      status: 'drafting'
    };

    this.sessionsByGuild.set(guild.id, session);
    this.sessionsById.set(session.id, session);

    const reply = await interaction.reply({
      embeds: [this.buildDraftEmbed(session, guild)],
      components: [this.buildPickMenu(session, guild)],
      fetchReply: true
    });

    session.messageId = reply.id;

    if (this.audioManager) {
      this.audioManager.join(sourceVoice).catch((error) => {
        console.error('Failed to join draft voice channel for audio:', error);
      });
    }
  }

  async runMockDraft(interaction, requestedPlayers, config, spawnVoice, broadcast) {
    const totalPlayers = Number.parseInt(requestedPlayers, 10);
    if (Number.isNaN(totalPlayers)) {
      await interaction.reply({ content: 'Mock player count must be a number.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (totalPlayers < 4) {
      await interaction.reply({ content: 'Mock draft requires at least 4 players.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (totalPlayers % 2 !== 0) {
      await interaction.reply({ content: 'Mock draft requires an even player count.', flags: MessageFlags.Ephemeral });
      return;
    }

    const fakePlayers = Array.from({ length: totalPlayers }, (_, idx) => `Player${idx + 1}`);
    const shuffled = shuffle(fakePlayers);
    const [captainA, captainB, ...pool] = shuffled;
    const teamA = [captainA];
    const teamB = [captainB];
    const pickOrder = createSnakeOrder(pool.length, captainA, captainB);
    const steps = [];

    for (const picker of pickOrder) {
      const pickIndex = randomInt(pool.length);
      const picked = pool.splice(pickIndex, 1)[0];
      if (picker === captainA) {
        teamA.push(picked);
      } else {
        teamB.push(picked);
      }
      steps.push(`${picker} picked ${picked}`);
    }

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('Mock Draft Preview (Solo Test)')
          .setDescription([
            `This is a text-only simulation with ${totalPlayers} fake players.`,
            `Captains: **${captainA}** vs **${captainB}**`,
            `Team size: **${totalPlayers / 2}v${totalPlayers / 2}**`
          ].join('\n'))
          .addFields(
            { name: 'Team Alpha', value: formatNames(teamA), inline: true },
            { name: 'Team Bravo', value: formatNames(teamB), inline: true },
            { name: 'Draft Order', value: steps.join('\n'), inline: false }
          )
      ],
      ...(broadcast ? {} : { flags: MessageFlags.Ephemeral })
    });

    if (spawnVoice) {
      await this.spawnMockVoice(interaction, config);
    }
  }

  async spawnMockVoice(interaction, config) {
    const guild = await this.resolveGuild(interaction);
    if (!guild) {
      await interaction.followUp({
        content: 'Mock voice can only be created from a server command context. Run `/team-draft-mock` in a server text channel and re-register commands if this still appears.',
        flags: MessageFlags.Ephemeral
      }).catch(() => {});
      return;
    }

    if (this.mockVoiceByGuild.has(guild.id)) {
      await interaction.followUp({
        content: 'A mock voice room already exists in this server. Leave it to trigger cleanup first.',
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
        content: `Created ${voiceChannel} and moved you there for testing. It will auto-delete when empty.`,
        flags: MessageFlags.Ephemeral
      });
    } else {
      await interaction.followUp({
        content: `Created ${voiceChannel}. Join it to test voice permissions. It will auto-delete when empty.`,
        flags: MessageFlags.Ephemeral
      });
    }

    this.mockVoiceByGuild.set(guild.id, {
      channelId: voiceChannel.id,
      roleId: role.id,
      memberId: member.id
    });
  }

  buildLiveDraftTable(session, guild) {
    const resolveName = (id) => guild.members.cache.get(id)?.displayName || id;
    const alpha = session.teamA.map((id) => resolveName(id));
    const bravo = session.teamB.map((id) => resolveName(id));
    const rows = Math.max(alpha.length, bravo.length);
    const lines = ['# | Team Alpha               | Team Bravo'];

    for (let i = 0; i < rows; i += 1) {
      const a = (alpha[i] || '').slice(0, 24).padEnd(24, ' ');
      const b = (bravo[i] || '').slice(0, 24);
      lines.push(`${String(i + 1).padEnd(2, ' ')}| ${a} | ${b}`);
    }

    return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
  }

  buildDraftEmbed(session, guild) {
    const isComplete = session.pickIndex >= session.pickOrder.length;
    const currentCaptain = !isComplete ? session.pickOrder[session.pickIndex] : null;
    const title = isComplete ? 'Team Draft Complete' : 'Team Draft';

    return new EmbedBuilder()
      .setTitle(title)
      .setDescription([
        `**Captains:** <@${session.captains[0]}> vs <@${session.captains[1]}>`,
        `**Team size:** ${session.teamSize}v${session.teamSize}`,
        currentCaptain ? `**Current pick:** <@${currentCaptain}>` : '**Current pick:** none'
      ].join('\n'))
      .addFields(
        { name: 'Teams', value: this.buildLiveDraftTable(session, guild), inline: false },
        {
          name: 'Undrafted',
          value: session.pool.length > 0 ? formatMentions(session.pool) : 'No players left in the call.',
          inline: false
        }
      );
  }

  buildPickMenu(session, guild) {
    const options = session.pool.map((userId) => ({
      label: guild.members.cache.get(userId)?.displayName?.slice(0, 100) || userId,
      value: userId
    }));

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

  async buildTeamTable(session, guild) {
    const resolveName = async (id) => {
      const cached = guild.members.cache.get(id);
      if (cached) {
        return cached.displayName;
      }
      const fetched = await guild.members.fetch(id).catch(() => null);
      return fetched?.displayName || id;
    };

    const alpha = await Promise.all(session.teamA.map((id) => resolveName(id)));
    const bravo = await Promise.all(session.teamB.map((id) => resolveName(id)));
    const rows = Math.max(alpha.length, bravo.length);
    const lines = ['# | Team Alpha               | Team Bravo'];
    for (let i = 0; i < rows; i += 1) {
      const a = (alpha[i] || '').padEnd(24, ' ');
      const b = bravo[i] || '';
      lines.push(`${String(i + 1).padEnd(2, ' ')}| ${a} | ${b}`);
    }
    return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
  }

  async handlePick(interaction, config) {
    const [, sessionId] = interaction.customId.split(':');
    const session = this.getSessionById(sessionId);

    if (!session) {
      await interaction.reply({ content: 'This draft session no longer exists.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.user.id !== session.pickOrder[session.pickIndex]) {
      await interaction.reply({ content: 'It is not your turn to pick.', flags: MessageFlags.Ephemeral });
      return;
    }

    const pickedId = interaction.values[0];
    if (!session.pool.includes(pickedId)) {
      await interaction.reply({ content: 'That player is no longer available.', flags: MessageFlags.Ephemeral });
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
    await interaction.channel.send({
      content: nextCaptain
        ? `🧩 <@${interaction.user.id}> drafted <@${pickedId}>. Next pick: <@${nextCaptain}>`
        : `🧩 <@${interaction.user.id}> drafted <@${pickedId}>. Draft picks complete.`
    });

    const pickerName = interaction.member?.displayName || interaction.user.displayName || interaction.user.username;
    const pickedName = interaction.guild.members.cache.get(pickedId)?.displayName || 'the pick';
    const nextCaptainName = nextCaptain ? interaction.guild.members.cache.get(nextCaptain)?.displayName : null;
    if (this.audioManager) {
      this.audioManager.announcePick(interaction.guild, pickerName, pickedName, nextCaptainName).catch((error) => {
        console.error('Failed to announce draft pick in voice:', error);
      });
    }

    if (session.messageId) {
      const priorMessage = await interaction.channel.messages.fetch(session.messageId).catch(() => null);
      if (priorMessage) {
        await priorMessage.delete().catch(() => {});
      }
    }

    if (session.pickIndex < session.pickOrder.length) {
      const newMessage = await interaction.channel.send({
        embeds: [this.buildDraftEmbed(session, interaction.guild)],
        components: [this.buildPickMenu(session, interaction.guild)]
      });
      session.messageId = newMessage.id;
      return;
    }

    await this.postReadyToStart(interaction, session);
  }

  async postReadyToStart(interaction, session) {
    session.status = 'ready';
    const channel = interaction.channel;
    const teamTable = await this.buildTeamTable(session, interaction.guild);
    const readyMessage = await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('Draft Ready')
          .setDescription([
            'Teams are ready. Press **Start** to create temporary private voice channels and move players.',
            'Press **Cancel** to abort this draft.',
            '',
            teamTable
          ].join('\n'))
          .addFields(
            { name: 'Team Alpha', value: formatMentions(session.teamA), inline: true },
            { name: 'Team Bravo', value: formatMentions(session.teamB), inline: true },
            {
              name: 'Undrafted',
              value: session.pool.length > 0 ? formatMentions(session.pool) : 'None',
              inline: false
            }
          )
      ],
      components: [this.buildStartButtons(session.id)]
    });
    session.readyMessageId = readyMessage.id;
  }

  async finalizeDraft(interaction, session, config) {
    const guild = interaction.guild;
    const channel = interaction.channel;
    const [nameA, nameB] = shuffle(getTeamNamePool(config)).slice(0, 2);
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

      await interaction.editReply({ embeds: [this.buildDraftEmbed(session, guild)], components: [] });

      await channel.send({
        content: [
          '✅ Draft complete. Teams have been moved to private voice channels.',
          `**Team Alpha (${nameA})**: ${formatMentions(session.teamA)}`,
          `**Team Bravo (${nameB})**: ${formatMentions(session.teamB)}`,
          'Channels and roles are temporary and will be deleted once everyone leaves.'
        ].join('\n')
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

      await interaction.editReply({ content: '❌ Failed to start draft resources. Please try Start again.', components: [] }).catch(() => {});
      throw error;
    }
  }

  async handleStartDraftButton(interaction, config) {
    const [, sessionId] = interaction.customId.split(':');
    const session = this.getSessionById(sessionId);
    if (!session) {
      await interaction.reply({ content: 'This draft session no longer exists.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (session.status !== 'ready') {
      await interaction.reply({ content: 'This draft is not ready to start.', flags: MessageFlags.Ephemeral });
      return;
    }
    session.status = 'starting';
    await interaction.deferUpdate();
    await interaction.channel.send({ content: '🚀 Starting team channels and moving players...' });
    await this.finalizeDraft(interaction, session, config);
  }

  async handleAbortDraftButton(interaction) {
    const [, sessionId] = interaction.customId.split(':');
    const session = this.getSessionById(sessionId);
    if (!session) {
      await interaction.reply({ content: 'This draft session no longer exists.', flags: MessageFlags.Ephemeral });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
      return;
    }

    await this.clearDraftMessageComponents(guild, session);
    await this.cleanupSession(guild, session);
    await interaction.reply({ content: 'Draft cancelled.' });
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
      await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
      return;
    }

    const session = this.sessionsByGuild.get(guild.id);
    const mockSession = this.mockVoiceByGuild.get(guild.id);

    if (!session && !mockSession) {
      await interaction.reply({ content: 'No active draft or mock voice resources in this server.', flags: MessageFlags.Ephemeral });
      return;
    }

    const lines = [];
    if (session) {
      lines.push(`Active draft session: \`${session.id}\``);
      lines.push(`Team size: ${session.teamSize}v${session.teamSize}`);
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
      await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
      return;
    }

    const session = this.sessionsByGuild.get(guild.id);
    if (!session) {
      await interaction.reply({ content: 'No active draft session to cancel.', flags: MessageFlags.Ephemeral });
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
    await interaction.reply({ content: 'Draft cancelled and temporary resources cleaned up.' });
  }

  async cleanupDraft(interaction) {
    const guild = await this.resolveGuild(interaction);
    if (!guild) {
      await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
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
      await interaction.reply({ content: 'No active draft resources found to clean up.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply({ content: 'Forced cleanup completed for active draft resources.', flags: MessageFlags.Ephemeral });
  }

  async returnToVoice(interaction) {
    const guild = await this.resolveGuild(interaction);
    if (!guild) {
      await interaction.reply({ content: 'This command can only be used in a server.', flags: MessageFlags.Ephemeral });
      return;
    }

    const session = this.sessionsByGuild.get(guild.id);
    if (!session) {
      await interaction.reply({ content: 'No active draft session found.', flags: MessageFlags.Ephemeral });
      return;
    }

    const sourceChannel = guild.channels.cache.get(session.sourceVoiceId)
      || await guild.channels.fetch(session.sourceVoiceId).catch(() => null);
    if (!sourceChannel || sourceChannel.type !== ChannelType.GuildVoice) {
      await interaction.reply({
        content: 'Original draft voice channel no longer exists, so players cannot be returned automatically.',
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
    await interaction.reply({ content: `Returned players to ${sourceChannel} and cleaned up draft resources.` });
  }
}

module.exports = {
  DraftManager
};
