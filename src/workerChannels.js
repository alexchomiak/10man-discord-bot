'use strict';

const DISCORD_ID = /^\d{17,20}$/;
const MAX_CHANNELS = 5000;
const CHANNEL_CACHE_MS = 5 * 60000;
const BROKER_MAX_PAYLOAD = 4 * 1024 * 1024;

function parseDashboardServerIds(value) {
  const ids = String(value || '').split(',').map(id => id.trim()).filter(Boolean);
  if (ids.some(id => !DISCORD_ID.test(id))) throw new Error('STREAM_DASHBOARD_SERVER_IDS must contain comma-separated Discord server IDs.');
  return [...new Set(ids)];
}
function canJoinChannel(channel, member) {
  if (!channel || !member || ![2, 13, 'GUILD_VOICE', 'GUILD_STAGE_VOICE'].includes(channel.type)) return false;
  try {
    const permissions = channel.permissionsFor?.(member);
    return !!permissions?.has('VIEW_CHANNEL') && !!permissions?.has('CONNECT') &&
      (!member.communicationDisabledUntilTimestamp || member.communicationDisabledUntilTimestamp <= Date.now() || !!permissions.has('ADMINISTRATOR'));
  } catch { return false; }
}
const MAX_CHANNEL_MEMBERS = 8;
const MAX_TOTAL_MEMBERS = 256;
const cleanName = (name, max = 100) => String(name || '').replace(/[\p{Cc}]/gu, ' ').slice(0, max);
function memberDto(member, user, id) {
  let avatarUrl = null;
  try {
    const url = new URL(member?.displayAvatarURL?.({ size: 64, format: 'png', extension: 'png' }) || user?.displayAvatarURL?.({ size: 64, format: 'png', extension: 'png' }));
    if (url.protocol === 'https:' && ['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) && url.href.length <= 256) avatarUrl = url.href;
  } catch {}
  return { id, displayName: cleanName(member?.displayName || member?.nickname || user?.globalName || user?.username || id, 64), avatarUrl };
}
function cachedOccupants(channels, client) {
  const byChannel = new Map(), visited = new Set();
  const allowedChannels = new Set(channels.map(channel => channel.id));
  for (const channel of channels) {
    if (visited.has(channel.guildId)) continue;
    visited.add(channel.guildId);
    const guild = client?.guilds?.cache?.get(channel.guildId);
    if (!guild) continue;
    const states = guild.voiceStates?.cache;
    if (states?.values) {
      for (const state of states.values()) {
        const channelId = state.channelId;
        const id = String(state.id || state.member?.id || '');
        if (!channelId || !allowedChannels.has(channelId) || !DISCORD_ID.test(id)) continue;
        const group = byChannel.get(channelId) || { memberCount: 0, members: [] };
        group.memberCount++;
        if (group.members.length < MAX_CHANNEL_MEMBERS) {
          const member = guild.members?.cache?.get(id) || state.member;
          const user = member?.user || client.users?.cache?.get(id);
          group.members.push(memberDto(member, user, id));
        }
        byChannel.set(channelId, group);
      }
    } else {
      for (const descriptor of channels.filter(item => item.guildId === channel.guildId)) {
        const members = guild.channels?.cache?.get(descriptor.id)?.members;
        if (!members?.values) continue;
        const group = { memberCount: members.size || 0, members: [] };
        for (const member of members.values()) {
          if (group.members.length >= MAX_CHANNEL_MEMBERS) break;
          const id = String(member?.id || member?.user?.id || '');
          if (DISCORD_ID.test(id)) group.members.push(memberDto(member, member.user, id));
        }
        byChannel.set(descriptor.id, group);
      }
    }
  }
  return channels.map(channel => ({ ...channel, ...(byChannel.get(channel.id) || { members: [], memberCount: 0 }) }));
}
function sanitizeAvailableChannels(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  let remainingMembers = MAX_TOTAL_MEMBERS;
  return value.slice(0, MAX_CHANNELS).flatMap(channel => {
    if (!channel || !DISCORD_ID.test(String(channel.guildId || '')) || !DISCORD_ID.test(String(channel.id || '')) ||
        typeof channel.guildName !== 'string' || typeof channel.name !== 'string' ||
        ![2, 13, 'GUILD_VOICE', 'GUILD_STAGE_VOICE'].includes(channel.type) || seen.has(channel.id)) return [];
    seen.add(channel.id);
    const members = [];
    const memberIds = new Set();
    for (const member of Array.isArray(channel.members) ? channel.members : []) {
      if (members.length >= MAX_CHANNEL_MEMBERS || remainingMembers <= 0) break;
      if (!member || !DISCORD_ID.test(String(member.id || '')) || memberIds.has(member.id)) continue;
      memberIds.add(member.id);
      let avatarUrl = null;
      try {
        const url = new URL(member.avatarUrl);
        if (url.protocol === 'https:' && ['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname) && url.href.length <= 256) avatarUrl = url.href;
      } catch {}
      members.push({ id: String(member.id), displayName: cleanName(member.displayName || member.id, 64), avatarUrl });
      remainingMembers--;
    }
    return [{ guildId: String(channel.guildId), guildName: cleanName(channel.guildName),
      id: String(channel.id), name: cleanName(channel.name), type: channel.type,
      ...(channel.memberCount !== undefined || channel.members !== undefined ? { members,
        memberCount: Number.isSafeInteger(channel.memberCount) && channel.memberCount >= members.length ? Math.min(channel.memberCount, 1000000) : members.length } : {}) }];
  });
}
async function bounded(operation) {
  let timer, expired = false;
  try { return await Promise.race([operation(() => expired), new Promise(resolve => { timer = setTimeout(() => { expired = true; resolve(null); }, 4000); timer.unref?.(); })]); }
  catch { return null; }
  finally { clearTimeout(timer); }
}

class WorkerChannelDiscovery {
  constructor(client, config = {}, now = Date.now) {
    this.client = client;
    this.config = config;
    this.now = now;
    this.cache = null;
    this.pending = null;
  }
  async list({ guildIds, refresh = false } = {}) {
    if (guildIds !== undefined && (!Array.isArray(guildIds) || guildIds.length > 1000 || guildIds.some(id => typeof id !== 'string' || !DISCORD_ID.test(id)))) {
      return { ok: false, message: 'Invalid server ID list.' };
    }
    const allowlist = new Set(this.config.dashboardServerIds || []);
    const ids = [...new Set(guildIds || (allowlist.size ? [...allowlist] : [...(this.client?.guilds?.cache?.keys?.() || [])]))]
      .filter(id => !allowlist.size || allowlist.has(id)).sort();
    const key = ids.join(',');
    if (!refresh && this.cache?.key === key && this.now() - this.cache.at < CHANNEL_CACHE_MS) return this.cached();
    if (this.pending) {
      await this.pending;
      return this.list({ guildIds, refresh: false });
    }
    this.pending = this._discover(ids).then(result => { this.cache = { key, at: this.now(), result }; return result; });
    try { await this.pending; return { ...this.cached(), cached: false }; }
    finally { this.pending = null; }
  }
  cached() {
    if (!this.cache) return null;
    return { ...this.cache.result, cached: true,
      availableChannels: sanitizeAvailableChannels(cachedOccupants(this.cache.result.availableChannels, this.client)) };
  }
  async _discover(ids) {
    const channels = [], unavailableGuildIds = [];
    let cursor = 0;
    const discover = async () => {
      while (cursor < ids.length) {
        const guildId = ids[cursor++];
        const found = await bounded(async expired => {
          const guild = this.client.guilds.cache.get(guildId) || await this.client.guilds.fetch(guildId);
          if (!guild || expired()) return null;
          const member = guild.members?.me || guild.members?.cache?.get(this.client.user?.id) || await (guild.members?.fetchMe?.() || guild.members?.fetch(this.client.user?.id));
          if (!member || expired()) return null;
          const collection = await guild.channels.fetch();
          if (!collection?.values || expired()) return null;
          return [...collection.values()].filter(channel => canJoinChannel(channel, member)).map(channel => ({
            guildId, guildName: guild.name, id: channel.id, name: channel.name, type: channel.type
          }));
        });
        if (found) channels.push(...found);
        else unavailableGuildIds.push(guildId);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, ids.length) }, discover));
    channels.sort((a, b) => a.guildName.localeCompare(b.guildName) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return { ok: true, availableChannels: sanitizeAvailableChannels(channels),
      channelsTruncated: channels.length > MAX_CHANNELS, unavailableGuildIds, cached: false };
  }
}
module.exports = { parseDashboardServerIds, canJoinChannel, sanitizeAvailableChannels, WorkerChannelDiscovery,
  MAX_CHANNELS, CHANNEL_CACHE_MS, BROKER_MAX_PAYLOAD, MAX_CHANNEL_MEMBERS, MAX_TOTAL_MEMBERS };
