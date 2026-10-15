'use strict';
const crypto = require('node:crypto');
const MAX_ARTWORK_BYTES = 256 * 1024;
const CAPABILITY = /^[a-f0-9]{32}$/;
function artworkScope(status) {
  const item = status?.current;
  if (status?.alive !== true || status?.inChannel !== true || !status.guildId || !status.channelId ||
      !item || item.isFiller || !item.thumbnail || !['jellyfin', 'sharetv'].includes(item.sourceKind)) return null;
  return crypto.createHash('sha256').update(JSON.stringify([status.guildId, status.channelId,
    status.startedAt, item.id, item.thumbnail, item.title, item.contentTitle])).digest('hex');
}
function artworkUrl(config, capability) {
  if (!CAPABILITY.test(capability || '')) return null;
  const id = config.dashboardRandomCodes ? config.dashboardAccessCode : config.workerId || config.defaultWorkerId || 'primary';
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id || '')) return null;
  try {
    const base = new URL(config.dashboardBaseUrl);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) return null;
    return new URL(`/api/public/${id}/artwork/${capability}.jpg`, base).href;
  } catch { return null; }
}
module.exports = { MAX_ARTWORK_BYTES, CAPABILITY, artworkScope, artworkUrl };
