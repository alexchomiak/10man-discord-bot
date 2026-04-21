const {
  ActionRowBuilder,
  ChannelType,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  EmbedBuilder
} = require('discord.js');

const TEAM_NAMES = [
  'Mirage Mid',
  'Inferno Banana',
  'Nuke Ramp',
  'Ancient Temple',
  'Vertigo A Site',
  'Anubis Canal',
  'Dust2 Catwalk',
  'Train Yard'
];

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
  constructor() {
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
      await interaction.reply({ content: 'This command can only be used in a server.', ephemeral: true });
      return;
    }

    if (this.sessionsByGuild.has(guild.id)) {
      await interaction.reply({
        content: 'A draft is already active in this server. Finish or cancel it before starting another.',
        ephemeral: true
      });
      return;
    }

    const member = await guild.members.fetch(interaction.user.id);
    const sourceVoice = member.voice?.channel;
    if (!sourceVoice || sourceVoice.type !== ChannelType.GuildVoice) {
      await interaction.reply({
        content: 'Join a voice channel first, then run `/team-draft`.',
        ephemeral: true
      });
      return;
    }

    const players = sourceVoice.members.filter((m) => !m.user.bot);
    if (players.size < config.minPlayers) {
      await interaction.reply({
        content: `Need at least ${config.minPlayers} non-bot players in your voice channel.`,
        ephemeral: true
      });
      return;
    }

    if (players.size % 2 !== 0) {
      await interaction.reply({
        content: `Need an even number of players. You currently have ${players.size}.`,
        ephemeral: true
      });
      return;
    }

    const playerIds = shuffle([...players.keys()]);
    const [captainA, captainB, ...pool] = playerIds;
    const teamSize = playerIds.length / 2;
    const pickOrder = createSnakeOrder(pool.length, captainA, captainB);

    const sessionId = `${guild.id}-${Date.now()}`;
    const session = {
      id: sessionId,
      guildId: guild.id,
      sourceVoiceId: sourceVoice.id,
      textChannelId: interaction.channelId,
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
      }
    };

    this.sessionsByGuild.set(guild.id, session);
    this.sessionsById.set(session.id, session);

    const reply = await interaction.reply({
      embeds: [this.buildDraftEmbed(session)],
      components: [this.buildPickMenu(session, guild)],
      fetchReply: true
    });

    session.messageId = reply.id;
  }

  async runMockDraft(interaction, requestedPlayers, config, spawnVoice, broadcast) {
    const totalPlayers = Number.parseInt(requestedPlayers, 10);
    if (Number.isNaN(totalPlayers)) {
      await interaction.reply({ content: 'Mock player count must be a number.', ephemeral: true });
      return;
    }

    if (totalPlayers < 4) {
      await interaction.reply({ content: 'Mock draft requires at least 4 players.', ephemeral: true });
      return;
    }

    if (totalPlayers % 2 !== 0) {
      await interaction.reply({ content: 'Mock draft requires an even player count.', ephemeral: true });
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
      ephemeral: !broadcast
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
        ephemeral: true
      }).catch(() => {});
      return;
    }

    if (this.mockVoiceByGuild.has(guild.id)) {
      await interaction.followUp({
        content: 'A mock voice room already exists in this server. Leave it to trigger cleanup first.',
        ephemeral: true
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
        ephemeral: true
      });
    } else {
      await interaction.followUp({
        content: `Created ${voiceChannel}. Join it to test voice permissions. It will auto-delete when empty.`,
        ephemeral: true
      });
    }

    this.mockVoiceByGuild.set(guild.id, {
      channelId: voiceChannel.id,
      roleId: role.id,
      memberId: member.id
    });
  }

  buildDraftEmbed(session) {
    const currentCaptain = session.pickOrder[session.pickIndex];
    const title = session.pool.length === 0 ? 'Draft Complete' : 'CS2 Team Draft';

    return new EmbedBuilder()
      .setTitle(title)
      .setDescription([
        `**Captains:** <@${session.captains[0]}> vs <@${session.captains[1]}>`,
        `**Team size:** ${session.teamSize}v${session.teamSize}`,
        session.pool.length > 0 ? `**Current pick:** <@${currentCaptain}>` : '**Current pick:** none'
      ].join('\n'))
      .addFields(
        { name: 'Team Alpha', value: formatMentions(session.teamA), inline: true },
        { name: 'Team Bravo', value: formatMentions(session.teamB), inline: true },
        {
          name: 'Undrafted',
          value: session.pool.length > 0 ? formatMentions(session.pool) : 'No players left.',
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

  async handlePick(interaction, config) {
    const [, sessionId] = interaction.customId.split(':');
    const session = this.getSessionById(sessionId);

    if (!session) {
      await interaction.reply({ content: 'This draft session no longer exists.', ephemeral: true });
      return;
    }

    if (interaction.user.id !== session.pickOrder[session.pickIndex]) {
      await interaction.reply({ content: 'It is not your turn to pick.', ephemeral: true });
      return;
    }

    const pickedId = interaction.values[0];
    if (!session.pool.includes(pickedId)) {
      await interaction.reply({ content: 'That player is no longer available.', ephemeral: true });
      return;
    }

    session.pool = session.pool.filter((id) => id !== pickedId);

    if (interaction.user.id === session.captains[0]) {
      session.teamA.push(pickedId);
    } else {
      session.teamB.push(pickedId);
    }

    session.pickIndex += 1;

    if (session.pool.length > 0) {
      await interaction.update({
        embeds: [this.buildDraftEmbed(session)],
        components: [this.buildPickMenu(session, interaction.guild)]
      });
      return;
    }

    await this.finalizeDraft(interaction, session, config);
  }

  async finalizeDraft(interaction, session, config) {
    const guild = interaction.guild;
    const channel = interaction.channel;
    const [nameA, nameB] = shuffle(TEAM_NAMES).slice(0, 2);
    const suffix = session.id.slice(-4);

    const roleA = await guild.roles.create({ name: `draft-${suffix}-alpha`, mentionable: false, hoist: false });
    const roleB = await guild.roles.create({ name: `draft-${suffix}-bravo`, mentionable: false, hoist: false });

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

    const channelA = await guild.channels.create({
      name: `🔵 ${nameA}`,
      type: ChannelType.GuildVoice,
      parent: config.teamCategoryId || null,
      permissionOverwrites: [
        ...baseOverwrites,
        { id: roleA.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] }
      ]
    });

    const channelB = await guild.channels.create({
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

    await interaction.update({ embeds: [this.buildDraftEmbed(session)], components: [] });

    await channel.send({
      content: [
        '✅ Draft complete. Teams have been moved to private voice channels.',
        `**Team Alpha (${nameA})**: ${formatMentions(session.teamA)}`,
        `**Team Bravo (${nameB})**: ${formatMentions(session.teamB)}`,
        'Channels and roles are temporary and will be deleted once everyone leaves.'
      ].join('\n')
    });
  }

  async handleVoiceStateUpdate(oldState, newState) {
    const guildId = oldState.guild.id;
    const mockSession = this.mockVoiceByGuild.get(guildId);
    if (mockSession && oldState.channelId === mockSession.channelId) {
      const mockChannel = oldState.guild.channels.cache.get(mockSession.channelId);
      if (mockChannel && mockChannel.members.size === 0) {
        await mockChannel.delete('Temporary mock voice channel is empty').catch(() => {});
        const role = oldState.guild.roles.cache.get(mockSession.roleId);
        if (role) {
          const holder = await oldState.guild.members.fetch(mockSession.memberId).catch(() => null);
          if (holder && holder.roles.cache.has(role.id)) {
            await holder.roles.remove(role).catch(() => {});
          }
          await role.delete('Mock draft cleanup').catch(() => {});
        }
        this.mockVoiceByGuild.delete(guildId);
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

    this.sessionsByGuild.delete(session.guildId);
    this.sessionsById.delete(session.id);
  }
}

module.exports = {
  DraftManager
};
