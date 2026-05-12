const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const Database = require('better-sqlite3');

const STEAM_ID_64_RE = /^7656119\d{10}$/;
const DEFAULT_RATING_REFRESH_INTERVAL_HOURS = 24;
const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
const DEFAULT_CONCURRENCY = 3;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_LEETIFY_API_BASE = 'https://api-public.cs-prod.leetify.com';
const STEAM_API_BASE = 'https://api.steampowered.com';

class PlayerManagerError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'PlayerManagerError';
    this.code = options.code || 'PLAYER_ERROR';
    this.cause = options.cause;
  }
}

function normalizeAlias(alias) {
  return String(alias || '').trim().toLowerCase();
}

function parsePositiveNumber(value, defaultValue) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function summarizeError(error) {
  return {
    name: error?.name,
    code: error?.code,
    message: error?.message,
    causeName: error?.cause?.name,
    causeCode: error?.cause?.code,
    causeMessage: error?.cause?.message
  };
}

function memberAliases(member) {
  return [
    member?.displayName,
    member?.nickname,
    member?.user?.globalName,
    member?.user?.displayName,
    member?.user?.username
  ].filter(Boolean);
}

function extractSteamIdentifier(profileUrl) {
  const raw = String(profileUrl || '').trim();
  if (STEAM_ID_64_RE.test(raw)) {
    return { steamId64: raw, profileUrl: `https://steamcommunity.com/profiles/${raw}` };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PlayerManagerError('Steam profile must be a valid Steam profile URL or SteamID64.', { code: 'INVALID_STEAM_PROFILE_URL' });
  }

  if (!['steamcommunity.com', 'www.steamcommunity.com'].includes(parsed.hostname.toLowerCase())) {
    throw new PlayerManagerError('Steam profile URL must be on steamcommunity.com.', { code: 'INVALID_STEAM_PROFILE_HOST' });
  }

  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts[0] === 'profiles' && STEAM_ID_64_RE.test(parts[1] || '')) {
    return { steamId64: parts[1], profileUrl: `https://steamcommunity.com/profiles/${parts[1]}` };
  }

  if (parts[0] === 'id' && parts[1]) {
    return { vanity: decodeURIComponent(parts[1]), profileUrl: `https://steamcommunity.com/id/${encodeURIComponent(decodeURIComponent(parts[1]))}` };
  }

  throw new PlayerManagerError('Steam profile URL must look like steamcommunity.com/id/name or steamcommunity.com/profiles/SteamID64.', { code: 'UNSUPPORTED_STEAM_PROFILE_URL' });
}

function parseRatingValue(value) {
  if (Number.isInteger(value)) {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string') {
    const match = value.match(/\d[\d,\s]*/);
    if (match) {
      return Number.parseInt(match[0].replace(/[,\s]/g, ''), 10);
    }
  }

  return null;
}

function isLikelyPremierRating(path, key, rating) {
  if (!Number.isInteger(rating) || rating <= 0 || rating > 50_000) {
    return false;
  }

  const normalizedPath = `${path}.${key}`.toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (normalizedPath.includes('premier') || normalizedPath.includes('csrating')) {
    return true;
  }

  if (normalizedPath.includes('currentrank') && rating >= 1_000) {
    return true;
  }

  return normalizedPath.includes('cs2')
    && (normalizedPath.includes('rank') || normalizedPath.includes('rating') || normalizedPath.includes('skilllevel'))
    && rating >= 1_000;
}

function findPremierRating(value, path = '') {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const nested = findPremierRating(value[index], `${path}[${index}]`);
      if (nested) {
        return nested;
      }
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    const rating = parseRatingValue(child);
    if (isLikelyPremierRating(path, key, rating)) {
      return rating;
    }
  }

  for (const [key, child] of Object.entries(value)) {
    const nested = findPremierRating(child, path ? `${path}.${key}` : key);
    if (nested) {
      return nested;
    }
  }

  return null;
}

function stringifyJson(value) {
  return value && typeof value === 'object' ? JSON.stringify(value) : null;
}

function extractLeetifyMetadata(data) {
  const premierRating = parseRatingValue(data?.ranks?.premier) || findPremierRating(data);
  return {
    premierRating,
    profileName: data?.name || null,
    profileId: data?.id || null,
    privacyMode: data?.privacy_mode || null,
    totalMatches: Number.isInteger(data?.total_matches) ? data.total_matches : null,
    winrate: typeof data?.winrate === 'number' ? data.winrate : null,
    firstMatchDate: data?.first_match_date || null,
    ranksJson: stringifyJson(data?.ranks),
    ratingJson: stringifyJson(data?.rating),
    statsJson: stringifyJson(data?.stats)
  };
}

async function runLimited(items, concurrency, task) {
  const results = [];
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { ok: true, value: await task(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

class PlayerManager {
  constructor(config = {}) {
    this.config = config;
    this.dbPath = config.sqlitePath || '/app/data/bot.db';
    this.steamApiKey = config.steamWebApiKey || process.env.STEAM_WEB_API_KEY || null;
    this.leetifyApiKey = config.leetifyApiKey || process.env.LEETIFY_API_KEY || null;
    this.leetifyApiBase = config.leetifyApiBase || process.env.LEETIFY_API_BASE || DEFAULT_LEETIFY_API_BASE;
    this.refreshIntervalHours = parsePositiveNumber(config.ratingRefreshIntervalHours || process.env.RATING_REFRESH_INTERVAL_HOURS, DEFAULT_RATING_REFRESH_INTERVAL_HOURS);
    this.httpTimeoutMs = Number.parseInt(config.playerHttpTimeoutMs || process.env.PLAYER_HTTP_TIMEOUT_MS || DEFAULT_HTTP_TIMEOUT_MS, 10);
    this.db = null;
    this.refreshTimer = null;
    this.refreshInProgress = false;
  }

  start() {
    this.initDb();
    this.scheduleRefresh();
  }

  stop() {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  initDb() {
    if (this.db) {
      return;
    }

    const dir = path.dirname(this.dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS player_links (
        alias TEXT PRIMARY KEY,
        alias_normalized TEXT NOT NULL UNIQUE,
        steam_profile_url TEXT NOT NULL,
        steam_id64 TEXT NOT NULL UNIQUE,
        premier_rating INTEGER,
        rating_source TEXT,
        rating_updated_at TEXT,
        leetify_profile_name TEXT,
        leetify_profile_id TEXT,
        privacy_mode TEXT,
        total_matches INTEGER,
        winrate REAL,
        first_match_date TEXT,
        ranks_json TEXT,
        rating_json TEXT,
        stats_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_player_links_alias_normalized ON player_links(alias_normalized);
      CREATE INDEX IF NOT EXISTS idx_player_links_steam_id64 ON player_links(steam_id64);
    `);

    this.addMissingPlayerLinkColumns();
  }

  addMissingPlayerLinkColumns() {
    const existingColumns = new Set(this.db.prepare('PRAGMA table_info(player_links)').all().map((column) => column.name));
    const columns = {
      leetify_profile_name: 'TEXT',
      leetify_profile_id: 'TEXT',
      privacy_mode: 'TEXT',
      total_matches: 'INTEGER',
      winrate: 'REAL',
      first_match_date: 'TEXT',
      ranks_json: 'TEXT',
      rating_json: 'TEXT',
      stats_json: 'TEXT'
    };

    for (const [name, type] of Object.entries(columns)) {
      if (!existingColumns.has(name)) {
        this.db.prepare(`ALTER TABLE player_links ADD COLUMN ${name} ${type}`).run();
      }
    }
  }

  scheduleRefresh() {
    this.stop();
    const delayMs = Math.max(60_000, this.refreshIntervalHours * 60 * 60 * 1000);
    this.refreshTimer = setTimeout(async () => {
      await this.refreshAllRatings().catch((error) => {
        console.error('[players] scheduled rating refresh failed:', summarizeError(error));
      });
      this.scheduleRefresh();
    }, delayMs);
  }

  async link(alias, steamProfileUrl) {
    this.initDb();
    const cleanAlias = String(alias || '').trim();
    const aliasNormalized = normalizeAlias(cleanAlias);
    if (!aliasNormalized) {
      throw new PlayerManagerError('Alias is required.', { code: 'ALIAS_REQUIRED' });
    }

    const steam = extractSteamIdentifier(steamProfileUrl);
    const steamId64 = steam.steamId64 || await this.resolveVanityUrl(steam.vanity);
    const profileUrl = steam.steamId64 ? steam.profileUrl : `https://steamcommunity.com/id/${encodeURIComponent(steam.vanity)}`;
    const metadata = await this.fetchLeetifyProfileMetadata(steamId64).catch((error) => {
      console.warn('[players] failed to fetch Leetify metadata during link:', summarizeError(error));
      return null;
    });

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO player_links (
        alias, alias_normalized, steam_profile_url, steam_id64, premier_rating, rating_source, rating_updated_at,
        leetify_profile_name, leetify_profile_id, privacy_mode, total_matches, winrate, first_match_date, ranks_json, rating_json, stats_json, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(alias_normalized) DO UPDATE SET
        alias = excluded.alias,
        steam_profile_url = excluded.steam_profile_url,
        steam_id64 = excluded.steam_id64,
        premier_rating = excluded.premier_rating,
        rating_source = excluded.rating_source,
        rating_updated_at = excluded.rating_updated_at,
        leetify_profile_name = excluded.leetify_profile_name,
        leetify_profile_id = excluded.leetify_profile_id,
        privacy_mode = excluded.privacy_mode,
        total_matches = excluded.total_matches,
        winrate = excluded.winrate,
        first_match_date = excluded.first_match_date,
        ranks_json = excluded.ranks_json,
        rating_json = excluded.rating_json,
        stats_json = excluded.stats_json,
        updated_at = excluded.updated_at
    `).run(
      cleanAlias,
      aliasNormalized,
      profileUrl,
      steamId64,
      metadata?.premierRating || null,
      metadata?.premierRating ? 'leetify' : null,
      metadata?.premierRating ? now : null,
      metadata?.profileName || null,
      metadata?.profileId || null,
      metadata?.privacyMode || null,
      metadata?.totalMatches || null,
      metadata?.winrate || null,
      metadata?.firstMatchDate || null,
      metadata?.ranksJson || null,
      metadata?.ratingJson || null,
      metadata?.statsJson || null,
      now
    );

    return this.getByAlias(cleanAlias);
  }

  unlink(alias) {
    this.initDb();
    const result = this.db.prepare('DELETE FROM player_links WHERE alias_normalized = ?').run(normalizeAlias(alias));
    return result.changes > 0;
  }

  getByAlias(alias) {
    this.initDb();
    return this.db.prepare('SELECT * FROM player_links WHERE alias_normalized = ?').get(normalizeAlias(alias)) || null;
  }

  getAll() {
    this.initDb();
    return this.db.prepare('SELECT * FROM player_links ORDER BY alias COLLATE NOCASE').all();
  }

  getLinkForMember(member) {
    this.initDb();
    for (const alias of memberAliases(member)) {
      const link = this.getByAlias(alias);
      if (link) {
        return link;
      }
    }
    return null;
  }

  getRatingForMember(member) {
    const link = this.getLinkForMember(member);
    return Number.isInteger(link?.premier_rating) ? link.premier_rating : null;
  }

  formatMemberLabel(member) {
    const name = member?.displayName || member?.user?.displayName || member?.user?.username || member?.id;
    const rating = this.getRatingForMember(member);
    return rating ? `${name} (${rating})` : name;
  }

  async refreshRatingForAlias(alias) {
    this.initDb();
    const link = this.getByAlias(alias);
    if (!link) {
      return null;
    }

    await this.refreshLinkRating(link);
    return this.getByAlias(alias);
  }

  async refreshAllRatings() {
    this.initDb();
    if (this.refreshInProgress) {
      return { skipped: true, reason: 'refresh already in progress' };
    }

    this.refreshInProgress = true;
    try {
      const links = this.getAll();
      const results = await runLimited(links, DEFAULT_CONCURRENCY, async (link) => this.refreshLinkRating(link));
      const updated = results.filter((result) => result.ok && result.value?.rating).length;
      const failed = results.filter((result) => !result.ok).length;
      return { total: links.length, updated, failed };
    } finally {
      this.refreshInProgress = false;
    }
  }

  async refreshRatingsForMembers(members) {
    this.initDb();
    const linksByAlias = new Map();
    for (const member of members.values()) {
      const link = this.getLinkForMember(member);
      if (link) {
        linksByAlias.set(link.alias_normalized, link);
      }
    }

    const links = [...linksByAlias.values()];
    const results = await runLimited(links, DEFAULT_CONCURRENCY, async (link) => this.refreshLinkRating(link));
    return {
      total: links.length,
      updated: results.filter((result) => result.ok && result.value?.rating).length,
      failed: results.filter((result) => !result.ok).length
    };
  }

  async refreshLinkRating(link) {
    const metadata = await this.fetchLeetifyProfileMetadata(link.steam_id64);
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE player_links
      SET premier_rating = ?, rating_source = ?, rating_updated_at = ?,
        leetify_profile_name = ?, leetify_profile_id = ?, privacy_mode = ?, total_matches = ?, winrate = ?, first_match_date = ?,
        ranks_json = ?, rating_json = ?, stats_json = ?, updated_at = ?
      WHERE alias_normalized = ?
    `).run(
      metadata.premierRating || null,
      metadata.premierRating ? 'leetify' : null,
      metadata.premierRating ? now : null,
      metadata.profileName || null,
      metadata.profileId || null,
      metadata.privacyMode || null,
      metadata.totalMatches || null,
      metadata.winrate || null,
      metadata.firstMatchDate || null,
      metadata.ranksJson || null,
      metadata.ratingJson || null,
      metadata.statsJson || null,
      now,
      link.alias_normalized
    );
    return { alias: link.alias, rating: metadata.premierRating };
  }

  async resolveVanityUrl(vanity) {
    if (!this.steamApiKey) {
      throw new PlayerManagerError('Resolving steamcommunity.com/id URLs requires STEAM_WEB_API_KEY. Use a /profiles/SteamID64 URL or set the key.', { code: 'STEAM_API_KEY_REQUIRED' });
    }

    const url = new URL('/ISteamUser/ResolveVanityURL/v0001/', STEAM_API_BASE);
    url.searchParams.set('key', this.steamApiKey);
    url.searchParams.set('vanityurl', vanity);
    const data = await this.fetchJson(url);
    const response = data?.response;
    if (response?.success !== 1 || !STEAM_ID_64_RE.test(response?.steamid || '')) {
      throw new PlayerManagerError(`Could not resolve Steam vanity URL '${vanity}'.`, { code: 'STEAM_VANITY_NOT_FOUND' });
    }
    return response.steamid;
  }

  async fetchLeetifyProfileMetadata(steamId64) {
    const url = new URL('/v3/profile', this.leetifyApiBase);
    url.searchParams.set('steam64_id', steamId64);
    const headers = { accept: 'application/json' };
    if (this.leetifyApiKey) {
      headers.authorization = this.leetifyApiKey;
      headers._leetify_key = this.leetifyApiKey;
    }
    const data = await this.fetchJson(url, headers);
    return extractLeetifyMetadata(data);
  }

  async fetchPremierRating(steamId64) {
    const metadata = await this.fetchLeetifyProfileMetadata(steamId64);
    return metadata.premierRating;
  }

  fetchJson(url, headers = {}) {
    const transport = url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const request = transport.request(url, { method: 'GET', headers, timeout: this.httpTimeoutMs }, (response) => {
        const chunks = [];
        let bytes = 0;
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            request.destroy(new PlayerManagerError('API response was too large.', { code: 'API_RESPONSE_TOO_LARGE' }));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new PlayerManagerError(`API request failed with HTTP ${response.statusCode}.`, { code: 'API_HTTP_ERROR' }));
            return;
          }
          try {
            resolve(text ? JSON.parse(text) : null);
          } catch (error) {
            reject(new PlayerManagerError('API response was not valid JSON.', { code: 'API_JSON_ERROR', cause: error }));
          }
        });
      });
      request.on('timeout', () => request.destroy(new PlayerManagerError('API request timed out.', { code: 'API_TIMEOUT' })));
      request.on('error', (error) => reject(error instanceof PlayerManagerError ? error : new PlayerManagerError('API request failed.', { code: 'API_REQUEST_FAILED', cause: error })));
      request.end();
    });
  }
}

module.exports = { PlayerManager, PlayerManagerError, summarizeError };
