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
function sanitizeAvailableChannels(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, MAX_CHANNELS).flatMap(channel => {
    if (!channel || !DISCORD_ID.test(String(channel.guildId || '')) || !DISCORD_ID.test(String(channel.id || '')) ||
        typeof channel.guildName !== 'string' || typeof channel.name !== 'string' ||
        ![2, 13, 'GUILD_VOICE', 'GUILD_STAGE_VOICE'].includes(channel.type) || seen.has(channel.id)) return [];
    seen.add(channel.id);
    return [{ guildId: String(channel.guildId), guildName: channel.guildName.slice(0, 100),
      id: String(channel.id), name: channel.name.slice(0, 100), type: channel.type }];
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
    if (!refresh && this.cache?.key === key && this.now() - this.cache.at < CHANNEL_CACHE_MS) return { ...this.cache.result, cached: true };
    if (this.pending) {
      await this.pending;
      return this.list({ guildIds, refresh: false });
    }
    this.pending = this._discover(ids).then(result => { this.cache = { key, at: this.now(), result }; return result; });
    try { return await this.pending; }
    finally { this.pending = null; }
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
  MAX_CHANNELS, CHANNEL_CACHE_MS, BROKER_MAX_PAYLOAD };
