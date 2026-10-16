'use strict';

// Display-only text: never publish HTML attributes, links, or control characters.
function presenceText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:#(x[\da-f]+|\d+)|([a-z]+));/gi, (match, numeric, named) => {
      if (numeric) {
        const n = numeric[0].toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : Number(numeric);
        return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' ';
      }
      return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[named.toLowerCase()] || ' ';
    })
    .replace(/<[^>]*>/g, ' ')
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|data:|www\.)\S+/gi, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function isTwitchUrl(raw) {
  try { return /^(?:[a-z0-9-]+\.)?twitch\.tv$/i.test(new URL(raw).hostname); }
  catch { return false; }
}

function ytdlpPresence(data, input) {
  if (/^twitch/i.test(data.extractor || data.extractor_key || '') || isTwitchUrl(input)) {
    const streamer = presenceText(data.channel || data.uploader || data.uploader_id);
    const categories = Array.isArray(data.categories) ? data.categories.map(presenceText).filter(Boolean) : [];
    const category = categories[0] || presenceText(data.game);
    const stream = /twitch(?::stream|stream)/i.test(data.extractor || data.extractor_key || '') || data.is_live === true;
    return { sourceKind: 'twitch', presenceTitle: stream ? presenceText(data.description) || null : null,
      presenceDetails: [...new Set([streamer, category].filter(Boolean))].join(' - ') || presenceText(data.description) || null };
  }
  const raw = typeof data.description === 'string' ? data.description : '';
  const links = raw.match(/(?:https?:\/\/|www\.)\S+/gi) || [];
  const linkLength = links.reduce((length, link) => length + link.length, 0);
  const description = presenceText(raw);
  const creator = presenceText(data.creator || data.channel || data.uploader || data.artist);
  return { presenceDetails: description.length >= 2 && linkLength <= raw.length / 2 ? description : creator || null };
}

function jellyfinPresence(item) {
  const name = presenceText(item.Name);
  const series = presenceText(item.SeriesName);
  const episode = item.Type === 'Episode' || Boolean(series);
  if (!episode) {
    const year = item.Type === 'Movie' && Number.isInteger(item.ProductionYear) &&
      item.ProductionYear >= 1888 && item.ProductionYear <= 2100 ? item.ProductionYear : null;
    const title = name && year && !name.endsWith(`(${year})`) ? `${name} (${year})` : name;
    return { presenceTitle: title || null, presenceDetails: presenceText(item.Overview) || null };
  }
  const season = Number.isInteger(item.ParentIndexNumber) && item.ParentIndexNumber >= 0 ? `S${item.ParentIndexNumber}` : '';
  const index = Number.isInteger(item.IndexNumber) && item.IndexNumber >= 0 ? `E${item.IndexNumber}` : '';
  const numbering = season + index;
  return { presenceTitle: series || name || null,
    presenceDetails: [name, numbering].filter(Boolean).join(' - ') || null };
}

module.exports = { presenceText, ytdlpPresence, jellyfinPresence, isTwitchUrl };
