'use strict';

const { RichPresence } = require('discord.js-selfbot-v13');
const { workerDashboardUrl } = require('./fillerArtwork');
const NAME = 'Stream Player';
const safeTitle = value => String(value || '').replace(/https?:\/\/\S+/gi, 'Stream');
const clip = (text, limit) => {
  const chars = Array.from(String(text || '').replace(/\s+/g, ' ').trim());
  return chars.length <= limit ? chars.join('') : chars.slice(0, Math.max(0, limit - 1)).join('') + '…';
};
function clock(seconds) {
  const value = Math.floor(Math.max(0, Number(seconds) || 0));
  const sec = String(value % 60).padStart(2, '0');
  const minutes = Math.floor(value / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${sec}` : `${minutes}:${sec}`;
}
function snapshot(manager, now = Date.now()) {
  const link = manager.voiceLink;
  const piece = link?.paused ? link.pausedSession : manager.session;
  let position = piece ? manager.positionOf?.(piece) || 0 : 0;
  if (link?.paused && Number.isFinite(link.pausedPositionSec)) position = link.pausedPositionSec;
  let duration = Number.isFinite(piece?.totalDurationSec) && piece.totalDurationSec > 0 ? piece.totalDurationSec : null;
  const chapter = piece?.musicMode || manager.musicMode ? manager._currentChapter?.(piece, position) : null;
  if (chapter && !piece?.isLive) {
    const next = piece.chapters?.[chapter.index + 1];
    const end = next?.startSec ?? duration;
    duration = Number.isFinite(end) && end > chapter.startSec ? end - chapter.startSec : null;
    position = Math.max(0, position - chapter.startSec);
  }
  const title = clip(safeTitle(chapter?.title || piece?.contentTitle || piece?.title || 'Stream Player'), 90);
  const timing = piece?.isLive ? `${clock(position)} elapsed - Live` : duration ? `${clock(position)}/${clock(duration)}` : clock(position);
  const suffix = ` - ${timing}${link?.paused ? ' - Paused' : ' - Playing'}`;
  const hover = clip(title, Math.min(90, 128 - Array.from(suffix).length)) + suffix;
  return { title, hover, paused: Boolean(link?.paused), music: Boolean(piece?.musicMode || manager.musicMode),
    position, duration: piece?.isLive ? null : duration, hasPiece: Boolean(piece && !piece.isFiller),
    thumbnail: piece?.thumbnail || null, start: now - Math.max(0, position) * 1000 };
}
function imageUrl(value) {
  try {
    const url = new URL(value);
    const sensitive = [...url.searchParams.keys()].some(key => /^(api.?key|token|access.?token|auth|key)$/i.test(key));
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !sensitive ? url.toString() : null;
  }
  catch { return null; }
}

// Presence is optional UI: never await it from the voice/media path. One trailing
// timer coalesces rapid moves and config changes; identical failures are not retried.
class PlayerPresence {
  constructor(client, manager, { log = () => {}, intervalMs = 15000, resolveAssets = RichPresence.getExternal } = {}) {
    this.client = client;
    this.manager = manager;
    this.log = log;
    this.resolveAssets = resolveAssets;
    this.assetCache = new Map();
    this.assetFlight = null;
    this.assetNextAt = 0;
    this.generation = 0;
    this.assetContext = null;
    this.lastKey = null;
    this.owned = false;
    this.lastSentAt = 0;
    this.timer = null;
    this.closed = false;
    this.poll = setInterval(() => this.sync(), intervalMs);
    this.poll.unref?.();
  }

  sync(force = false) {
    if (this.closed) return;
    try {
      const config = this.manager.config || {};
      const appId = config.playerPresenceApplicationId || '';
      const link = this.manager.voiceLink;
      const url = link && !link.closing && !link.disconnectFailed && /^\d{17,20}$/.test(appId)
        ? workerDashboardUrl(config.dashboardBaseUrl, config.dashboardRandomCodes
          ? config.dashboardAccessCode : config.workerId || config.defaultWorkerId || 'primary') : null;
      const state = snapshot(this.manager);
      const avatar = imageUrl(this.client.user?.displayAvatarURL?.({ format: 'png', size: 256 }));
      const large = imageUrl(state.thumbnail) || avatar;
      const context = url ? JSON.stringify([appId, url, link.guildId, link.channelId, large, avatar]) : '';
      if (context !== this.assetContext) { this.assetContext = context; this.generation++; }
      const images = url ? this.images(appId, [large, avatar].filter(Boolean)) : [];
      const key = url ? JSON.stringify([context, state.title, state.hover, state.paused, state.music,
        state.hasPiece, state.duration, images]) : '';
      if (!force && key === this.lastKey) return;
      if (!this.client.user) return;
      const remaining = 5000 - (Date.now() - this.lastSentAt);
      if (remaining > 0) {
        if (!this.timer) {
          this.timer = setTimeout(() => { this.timer = null; this.sync(force); }, remaining);
          this.timer.unref?.();
        }
        return;
      }
      this.lastKey = key;
      this.lastSentAt = Date.now();
      if (!url && !this.owned) return;
      // Preserve all other activities, including custom status. Remove only the
      // exact application/name pair this controller previously published.
      const activities = (this.client.presence?.activities || []).filter(activity =>
        !(this.owned && activity.name === NAME && activity.applicationId === this.ownedAppId));
      if (url) {
        const activity = new RichPresence(this.client).setApplicationId(appId)
          .setName(NAME).setType(state.music ? 'LISTENING' : 'WATCHING').setDetails(state.title)
          .setState(state.paused ? 'Paused' : state.hasPiece ? 'Now Playing' : 'Ready')
          .addButton('Open Player', url);
        if (state.hasPiece && !state.paused) {
          activity.setStartTimestamp(state.start);
          if (state.duration) activity.setEndTimestamp(state.start + state.duration * 1000);
        }
        if (images[0] || images[1]) activity.setAssetsLargeImage(images[0] || images[1]).setAssetsLargeText(state.hover);
        if (images[1]) activity.setAssetsSmallImage(images[1]).setAssetsSmallText(state.hover);
        activities.push(activity);
      }
      const result = this.client.user.setPresence({ activities });
      // The pinned library is synchronous; tolerate promise-returning adapters.
      Promise.resolve(result).catch(() => this.warn());
      this.owned = Boolean(url);
      this.ownedAppId = url ? appId : null;
    } catch { this.warn(); }
  }

  images(appId, urls) {
    const keys = urls.map(url => `${appId}:${url}`);
    const missing = urls.filter((url, index) => !this.assetCache.has(keys[index]));
    if (missing.length && !this.assetFlight && Date.now() >= this.assetNextAt) {
      const generation = this.generation;
      // The avatar is the final URL; resolve it first, independently of artwork.
      const unique = [...new Set(missing)].reverse().slice(0, 2);
      // Reserve failures too: no recurring retries for an unavailable image.
      for (const url of unique) {
        this.assetCache.set(`${appId}:${url}`, null);
        while (this.assetCache.size > 32) this.assetCache.delete(this.assetCache.keys().next().value);
      }
      this.assetNextAt = Date.now() + 30000;
      const flight = Promise.resolve().then(async () => {
        for (const url of unique) {
          if (this.closed || generation !== this.generation) return;
          try {
            // Resolve each image separately: a rejected thumbnail must never
            // poison the avatar. Even CDN avatar paths need a real proxy asset.
            const results = await this.resolveAssets(this.client, appId, url);
            if (this.closed || generation !== this.generation) return;
            const asset = results?.find(item => item.url === url) || results?.[0];
            const value = asset?.external_asset_path;
            if (typeof value === 'string' && value) this.assetCache.set(`${appId}:${url}`, value);
          } catch { /* cache this image failure without logging its URL */ }
          if (!this.closed && generation === this.generation) this.sync();
        }
      });
      this.assetFlight = flight;
      flight.catch(() => { /* optional artwork failure; no URLs in logs */ })
        .finally(() => {
          if (!this.closed && generation !== this.generation) {
            // A stale request is not an image failure. Release its reservations
            // so the current context can retry after the normal cooldown.
            for (const url of unique) {
              const key = `${appId}:${url}`;
              if (this.assetCache.get(key) === null) this.assetCache.delete(key);
            }
          }
          if (this.assetFlight === flight) this.assetFlight = null;
        });
    }
    return keys.map(key => this.assetCache.get(key) || null);
  }

  warn() { try { this.log('Player presence update failed; playback continues.'); } catch {} }

  close() {
    clearInterval(this.poll);
    clearTimeout(this.timer);
    this.closed = true;
    this.generation++;
    this.assetCache.clear();
  }
}

module.exports = { PlayerPresence, snapshot, clip, clock };
