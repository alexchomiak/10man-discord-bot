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
const DEFAULT_LEETIFY_LEGACY_API_BASE = 'https://api.cs-prod.leetify.com';
const STEAM_API_BASE = 'https://api.steampowered.com';
const DISCORD_NICKNAME_MAX_LENGTH = 32;
const NICKNAME_TOKEN_RE = /%([a-z_]+)%/gi;
const NICKNAME_VARIABLES = {
  rating: {
    watchColumn: 'watch_rating',
    render(link) {
      return Number.isInteger(link?.premier_rating) ? String(link.premier_rating) : null;
    }
  }
};

class PlayerManagerError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'PlayerManagerError';
    this.code = options.code || 'PLAYER_ERROR';
    this.cause = options.cause;
    this.statusCode = options.statusCode || null;
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
    statusCode: error?.statusCode,
    causeName: error?.cause?.name,
    causeCode: error?.cause?.code,
    causeMessage: error?.cause?.message
  };
}

function isMissingPermissionsError(error) {
  return error?.code === 50013 || error?.code === '50013' || error?.rawError?.code === 50013;
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

function uniqueNonEmpty(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function nicknameVariableNames(template) {
  const found = new Set();
  for (const match of String(template || '').matchAll(NICKNAME_TOKEN_RE)) {
    const name = match[1]?.toLowerCase();
    if (NICKNAME_VARIABLES[name]) {
      found.add(name);
    }
  }
  return [...found];
}

function stripNicknameVariables(template) {
  return String(template || '')
    .replace(NICKNAME_TOKEN_RE, ' ')
    .replace(/(?:\s*[-–—|•·:]+\s*)+$/g, '')
    .replace(/^(?:\s*[-–—|•·:]+\s*)+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function truncateNickname(value) {
  const text = String(value || '').trim();
  return text.length > DISCORD_NICKNAME_MAX_LENGTH ? text.slice(0, DISCORD_NICKNAME_MAX_LENGTH) : text;
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

function parseJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function stripDiscordMentionNoise(value) {
  return String(value || '').replace(/<@!?(\d+)>/g, '$1');
}

function truncate(value, maxLength) {
  const text = stripDiscordMentionNoise(value);
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function formatLeaderboardNumber(value) {
  if (value === null || value === undefined || value === '') {
    return '—';
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.parseFloat(value.toFixed(2)).toLocaleString('en-US');
  }

  return String(value);
}

function formatRatingChip(label, value) {
  return `**${label}:** ${formatLeaderboardNumber(value)}`;
}

function medalForRank(rank) {
  return ['🥇', '🥈', '🥉'][rank - 1] || `**${rank}.**`;
}

function parseNumeric(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function normalizeLeetifyRating(value, { scale = 1 } = {}) {
  const numeric = parseNumeric(value);
  if (numeric === null) {
    return null;
  }

  const rating = numeric * scale;
  return Number.isFinite(rating) ? Number.parseFloat(rating.toFixed(2)) : null;
}

function parseLegacyLeetifyRating(data) {
  return normalizeLeetifyRating(data?.recentGameRatings?.leetify, { scale: 100 });
}

function parsePublicLeetifyRating(data) {
  return normalizeLeetifyRating(data?.ranks?.leetify)
    ?? findLeetifyRatingValue(data?.rating || data?.ratings)
    ?? findLeetifyRatingValue(data?.stats || data?.lifetimeStats || data?.profileStats);
}

function findLeetifyRatingValue(value, path = '') {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const nested = findLeetifyRatingValue(value[index], `${path}[${index}]`);
      if (nested !== null) {
        return nested;
      }
    }
    return null;
  }

  for (const [key, child] of Object.entries(value)) {
    const normalizedPath = `${path}.${key}`.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (normalizedPath.includes('leetify')) {
      const numeric = parseNumeric(child);
      if (numeric !== null && numeric > -10 && numeric < 10) {
        return numeric;
      }
    }
  }

  for (const [key, child] of Object.entries(value)) {
    const nested = findLeetifyRatingValue(child, path ? `${path}.${key}` : key);
    if (nested !== null) {
      return nested;
    }
  }

  return null;
}

function parseLeetifyRank(link) {
  const ranks = parseJson(link?.ranks_json);
  const rating = parseJson(link?.rating_json);
  const stats = parseJson(link?.stats_json);
  return parseNumeric(ranks?.leetify)
    ?? findLeetifyRatingValue(rating)
    ?? findLeetifyRatingValue(stats);
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function findRecentPremierGame(games) {
  if (!Array.isArray(games)) {
    return null;
  }

  return games.find((game) => {
    const skillLevel = parseRatingValue(game?.skillLevel ?? game?.skill_level);
    return Number.isInteger(skillLevel) && skillLevel > 1_000;
  }) || null;
}

function buildLegacyRanks(data, premierRating, leetifyRating) {
  return {
    ...(isPlainObject(data?.ranks) ? data.ranks : {}),
    ...(premierRating ? { premier: premierRating } : {}),
    ...(leetifyRating !== null ? { leetify: leetifyRating } : {})
  };
}

function extractLeetifyMetadata(data, source = 'leetify-public') {
  const games = Array.isArray(data?.games) ? data.games : [];
  const recentPremierGame = findRecentPremierGame(games);
  const premierRating = parseRatingValue(data?.ranks?.premier)
    || parseRatingValue(recentPremierGame?.skillLevel ?? recentPremierGame?.skill_level)
    || findPremierRating(data);
  const leetifyRating = source === 'leetify-legacy'
    ? parseLegacyLeetifyRating(data)
    : parsePublicLeetifyRating(data);
  const ranks = source === 'leetify-legacy' ? buildLegacyRanks(data, premierRating, leetifyRating) : data?.ranks;

  return {
    source,
    premierRating,
    profileName: firstPresent(data?.name, data?.steam?.name, data?.profile?.name, data?.user?.name),
    profileId: firstPresent(data?.id, data?.leetifyUserId, data?.leetify_user_id),
    privacyMode: firstPresent(data?.privacy_mode, data?.privacyMode),
    totalMatches: Number.isInteger(data?.total_matches) ? data.total_matches : games.length || null,
    winrate: typeof data?.winrate === 'number' ? data.winrate : null,
    firstMatchDate: firstPresent(data?.first_match_date, data?.firstMatchDate),
    ranksJson: stringifyJson(ranks),
    ratingJson: stringifyJson(data?.rating || data?.ratings),
    statsJson: stringifyJson(data?.stats || data?.lifetimeStats || data?.profileStats),
    latestPremierGameJson: stringifyJson(recentPremierGame)
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
    this.leetifyLegacyApiBase = config.leetifyLegacyApiBase || process.env.LEETIFY_LEGACY_API_BASE || DEFAULT_LEETIFY_LEGACY_API_BASE;
    this.refreshIntervalHours = parsePositiveNumber(config.ratingRefreshIntervalHours || process.env.RATING_REFRESH_INTERVAL_HOURS, DEFAULT_RATING_REFRESH_INTERVAL_HOURS);
    this.httpTimeoutMs = Number.parseInt(config.playerHttpTimeoutMs || process.env.PLAYER_HTTP_TIMEOUT_MS || DEFAULT_HTTP_TIMEOUT_MS, 10);
    this.db = null;
    this.refreshTimer = null;
    this.refreshInProgress = false;
    this.client = null;
  }

  setClient(client) {
    this.client = client;
  }

  start(client = null) {
    if (client) {
      this.setClient(client);
    }
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
        discord_user_id TEXT,
        discord_guild_id TEXT,
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
        latest_premier_game_json TEXT,
        leetify_api_source TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_player_links_alias_normalized ON player_links(alias_normalized);
      CREATE INDEX IF NOT EXISTS idx_player_links_steam_id64 ON player_links(steam_id64);

      CREATE TABLE IF NOT EXISTS player_leaderboards (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS nickname_templates (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        original_nickname TEXT NOT NULL,
        last_rendered_nickname TEXT,
        watch_rating INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_nickname_templates_watch_rating ON nickname_templates(watch_rating);
    `);

    this.addMissingPlayerLinkColumns();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_player_links_discord_user_id ON player_links(discord_user_id);
      CREATE INDEX IF NOT EXISTS idx_player_links_discord_member ON player_links(discord_guild_id, discord_user_id);
    `);
    this.addMissingNicknameTemplateColumns();
  }

  addMissingPlayerLinkColumns() {
    const existingColumns = new Set(this.db.prepare('PRAGMA table_info(player_links)').all().map((column) => column.name));
    const columns = {
      discord_user_id: 'TEXT',
      discord_guild_id: 'TEXT',
      leetify_profile_name: 'TEXT',
      leetify_profile_id: 'TEXT',
      privacy_mode: 'TEXT',
      total_matches: 'INTEGER',
      winrate: 'REAL',
      first_match_date: 'TEXT',
      ranks_json: 'TEXT',
      rating_json: 'TEXT',
      stats_json: 'TEXT',
      latest_premier_game_json: 'TEXT',
      leetify_api_source: 'TEXT'
    };

    for (const [name, type] of Object.entries(columns)) {
      if (!existingColumns.has(name)) {
        this.db.prepare(`ALTER TABLE player_links ADD COLUMN ${name} ${type}`).run();
      }
    }
  }

  addMissingNicknameTemplateColumns() {
    const existingColumns = new Set(this.db.prepare('PRAGMA table_info(nickname_templates)').all().map((column) => column.name));
    for (const variable of Object.values(NICKNAME_VARIABLES)) {
      if (!existingColumns.has(variable.watchColumn)) {
        this.db.prepare(`ALTER TABLE nickname_templates ADD COLUMN ${variable.watchColumn} INTEGER NOT NULL DEFAULT 0`).run();
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
      await this.updateWatchedNicknames().catch((error) => {
        console.error('[players] scheduled nickname update failed:', summarizeError(error));
      });
      await this.updateAllLeaderboards().catch((error) => {
        console.error('[players] scheduled leaderboard update failed:', summarizeError(error));
      });
      this.scheduleRefresh();
    }, delayMs);
  }

  async link(alias, steamProfileUrl, owner = {}) {
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

    const discordUserId = owner?.discordUserId ? String(owner.discordUserId) : null;
    const discordGuildId = owner?.discordGuildId ? String(owner.discordGuildId) : null;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO player_links (
        alias, alias_normalized, steam_profile_url, steam_id64, discord_user_id, discord_guild_id, premier_rating, rating_source, rating_updated_at,
        leetify_profile_name, leetify_profile_id, privacy_mode, total_matches, winrate, first_match_date, ranks_json, rating_json, stats_json, latest_premier_game_json, leetify_api_source, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(alias_normalized) DO UPDATE SET
        alias = excluded.alias,
        steam_profile_url = excluded.steam_profile_url,
        steam_id64 = excluded.steam_id64,
        discord_user_id = excluded.discord_user_id,
        discord_guild_id = excluded.discord_guild_id,
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
        latest_premier_game_json = excluded.latest_premier_game_json,
        leetify_api_source = excluded.leetify_api_source,
        updated_at = excluded.updated_at
    `).run(
      cleanAlias,
      aliasNormalized,
      profileUrl,
      steamId64,
      discordUserId,
      discordGuildId,
      metadata?.premierRating || null,
      metadata?.premierRating ? metadata.source : null,
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
      metadata?.latestPremierGameJson || null,
      metadata?.source || null,
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

  getByDiscordMember(member) {
    this.initDb();
    const userId = member?.id || member?.user?.id;
    if (!userId) {
      return null;
    }

    const guildId = member?.guild?.id || null;
    if (guildId) {
      const guildLink = this.db.prepare(`
        SELECT * FROM player_links
        WHERE discord_user_id = ? AND (discord_guild_id = ? OR discord_guild_id IS NULL)
        ORDER BY discord_guild_id IS NULL ASC, updated_at DESC
      `).get(String(userId), String(guildId));
      if (guildLink) {
        return guildLink;
      }
    }

    return this.db.prepare('SELECT * FROM player_links WHERE discord_user_id = ? ORDER BY updated_at DESC').get(String(userId)) || null;
  }

  getAll() {
    this.initDb();
    return this.db.prepare('SELECT * FROM player_links ORDER BY alias COLLATE NOCASE').all();
  }

  getLinkForMember(member) {
    this.initDb();
    const memberLink = this.getByDiscordMember(member);
    if (memberLink) {
      return memberLink;
    }

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

  getNicknameTemplate(guildId, userId) {
    this.initDb();
    return this.db.prepare('SELECT * FROM nickname_templates WHERE guild_id = ? AND user_id = ?').get(guildId, userId) || null;
  }

  getWatchedRatingNicknames() {
    this.initDb();
    return this.db.prepare('SELECT * FROM nickname_templates WHERE watch_rating = 1 ORDER BY guild_id, user_id').all();
  }

  saveNicknameTemplate(member, originalNickname, lastRenderedNickname, variableNames) {
    this.initDb();
    const now = new Date().toISOString();
    const watchEntries = Object.entries(NICKNAME_VARIABLES).map(([name, variable]) => [variable.watchColumn, variableNames.includes(name) ? 1 : 0]);
    const watchColumns = watchEntries.map(([column]) => column);
    const insertColumns = ['guild_id', 'user_id', 'original_nickname', 'last_rendered_nickname', ...watchColumns, 'updated_at'];
    const updateColumns = ['original_nickname', 'last_rendered_nickname', ...watchColumns, 'updated_at'];
    const values = [member.guild.id, member.id, originalNickname, lastRenderedNickname, ...watchEntries.map(([, value]) => value), now];

    this.db.prepare(`
      INSERT INTO nickname_templates (${insertColumns.join(', ')})
      VALUES (${insertColumns.map(() => '?').join(', ')})
      ON CONFLICT(guild_id, user_id) DO UPDATE SET
        ${updateColumns.map((column) => `${column} = excluded.${column}`).join(',\n        ')}
    `).run(...values);
  }

  deleteNicknameTemplate(guildId, userId) {
    this.initDb();
    return this.db.prepare('DELETE FROM nickname_templates WHERE guild_id = ? AND user_id = ?').run(guildId, userId).changes > 0;
  }

  nicknameAliasCandidates(member, template, previousMember = null) {
    return uniqueNonEmpty([
      stripNicknameVariables(template),
      ...memberAliases(previousMember),
      ...memberAliases(member)
    ]);
  }

  getLinkForNicknameTemplate(member, template, previousMember = null) {
    const memberLink = this.getByDiscordMember(member);
    if (memberLink) {
      return memberLink;
    }

    for (const alias of this.nicknameAliasCandidates(member, template, previousMember)) {
      const link = this.getByAlias(alias);
      if (link) {
        return link;
      }
    }
    return null;
  }

  renderNicknameTemplate(template, link) {
    const rendered = String(template || '').replace(NICKNAME_TOKEN_RE, (token, rawName) => {
      const variable = NICKNAME_VARIABLES[String(rawName || '').toLowerCase()];
      if (!variable) {
        return token;
      }

      const value = variable.render(link);
      return value === null || value === undefined ? token : value;
    });
    return truncateNickname(rendered);
  }

  async applyRenderedNickname(member, renderedNickname) {
    if (!member || member.nickname === renderedNickname) {
      return false;
    }

    try {
      await member.setNickname(renderedNickname || null, 'Rendered tracked nickname variables');
      return true;
    } catch (error) {
      if (isMissingPermissionsError(error)) {
        console.warn(
          `[players] cannot update nickname for ${member.guild?.id || 'unknown-guild'}/${member.id}: `
          + 'Discord denied Manage Nicknames/role hierarchy permissions.'
        );
        return false;
      }
      throw error;
    }
  }

  async handleNicknameTemplateChange(member, nickname, previousMember = null) {
    this.initDb();
    if (!member?.guild || member.user?.bot) {
      return { action: 'ignored' };
    }

    const normalizedNickname = nickname || null;
    const existing = this.getNicknameTemplate(member.guild.id, member.id);
    const variableNames = nicknameVariableNames(normalizedNickname);
    if (variableNames.length === 0) {
      if (existing?.last_rendered_nickname && normalizedNickname === existing.last_rendered_nickname) {
        return { action: 'rendered_update_ignored' };
      }

      if (existing) {
        this.deleteNicknameTemplate(member.guild.id, member.id);
        return { action: 'deleted' };
      }

      return { action: 'ignored' };
    }

    const link = this.getLinkForNicknameTemplate(member, normalizedNickname, previousMember);
    const renderedNickname = this.renderNicknameTemplate(normalizedNickname, link);
    this.saveNicknameTemplate(member, normalizedNickname, renderedNickname, variableNames);

    if (!link) {
      const candidates = this.nicknameAliasCandidates(member, normalizedNickname, previousMember).join(', ');
      console.warn(`[players] nickname variables configured for ${member.id}, but no player link matched '${normalizedNickname}' (tried: ${candidates || 'none'}).`);
      return { action: 'saved_unmatched', renderedNickname, matched: false };
    }

    await this.applyRenderedNickname(member, renderedNickname);
    return { action: 'saved', renderedNickname, matched: true };
  }

  async handleMemberNicknameUpdate(oldMember, newMember) {
    this.initDb();
    if (!newMember?.guild || newMember.user?.bot) {
      return { action: 'ignored' };
    }

    const oldNickname = oldMember?.nickname || null;
    const newNickname = newMember?.nickname || null;
    if (oldNickname === newNickname && nicknameVariableNames(newNickname).length === 0) {
      return { action: 'unchanged' };
    }

    return this.handleNicknameTemplateChange(newMember, newNickname, oldMember);
  }

  async handleRawGuildMemberUpdate(packet) {
    this.initDb();
    if (packet?.t !== 'GUILD_MEMBER_UPDATE' || !this.client) {
      return { action: 'ignored' };
    }

    const data = packet.d || {};
    const guildId = data.guild_id;
    const userId = data.user?.id;
    if (!guildId || !userId || data.user?.bot) {
      return { action: 'ignored' };
    }

    const guild = this.client.guilds.cache.get(guildId) || await this.client.guilds.fetch(guildId);
    const member = guild.members.cache.get(userId) || await guild.members.fetch(userId);
    return this.handleNicknameTemplateChange(member, data.nick || null);
  }

  async updateWatchedNicknames() {
    this.initDb();
    if (!this.client) {
      return { total: 0, updated: 0, failed: 0, skipped: true };
    }

    const records = this.getWatchedRatingNicknames();
    let updated = 0;
    let failed = 0;

    for (const record of records) {
      try {
        const guild = await this.client.guilds.fetch(record.guild_id);
        const member = await guild.members.fetch(record.user_id);
        const link = this.getLinkForNicknameTemplate(member, record.original_nickname);
        const renderedNickname = this.renderNicknameTemplate(record.original_nickname, link);
        this.saveNicknameTemplate(member, record.original_nickname, renderedNickname, nicknameVariableNames(record.original_nickname));
        if (await this.applyRenderedNickname(member, renderedNickname)) {
          updated += 1;
        }
      } catch (error) {
        failed += 1;
        console.warn(`[players] failed to update watched nickname for ${record.guild_id}/${record.user_id}:`, summarizeError(error));
      }
    }

    return { total: records.length, updated, failed };
  }

  formatMemberLabel(member) {
    const name = member?.displayName || member?.user?.displayName || member?.user?.username || member?.id;
    const rating = this.getRatingForMember(member);
    return rating ? `${name} (${rating})` : name;
  }

  getLeaderboardRecord(guildId) {
    this.initDb();
    return this.db.prepare('SELECT * FROM player_leaderboards WHERE guild_id = ?').get(guildId) || null;
  }

  saveLeaderboardRecord(guildId, channelId, messageId) {
    this.initDb();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO player_leaderboards (guild_id, channel_id, message_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        channel_id = excluded.channel_id,
        message_id = excluded.message_id,
        updated_at = excluded.updated_at
    `).run(guildId, channelId, messageId, now);
  }

  getLeaderboardRecords() {
    this.initDb();
    return this.db.prepare('SELECT * FROM player_leaderboards ORDER BY guild_id').all();
  }

  getLeaderboardRows(limit = 25) {
    return this.getAll()
      .map((link) => ({
        alias: link.alias,
        aliasNormalized: link.alias_normalized,
        leetifyName: link.leetify_profile_name,
        premierRating: Number.isInteger(link.premier_rating) ? link.premier_rating : null,
        leetifyRank: parseLeetifyRank(link),
        ratingUpdatedAt: link.rating_updated_at
      }))
      .filter((row) => row.premierRating !== null || row.leetifyRank !== null)
      .sort((a, b) => {
        const premierDiff = (b.premierRating || 0) - (a.premierRating || 0);
        if (premierDiff !== 0) {
          return premierDiff;
        }
        return (b.leetifyRank || Number.NEGATIVE_INFINITY) - (a.leetifyRank || Number.NEGATIVE_INFINITY);
      })
      .slice(0, limit);
  }

  async buildMemberLookup(guild) {
    if (!guild?.members) {
      return new Map();
    }

    try {
      await guild.members.fetch();
    } catch (error) {
      console.warn('[players] could not fetch guild members for leaderboard mentions; using cache only:', summarizeError(error));
    }

    const lookup = new Map();
    for (const member of guild.members.cache.values()) {
      if (member.user?.bot) {
        continue;
      }
      const aliases = [member.id, ...memberAliases(member)].map((alias) => normalizeAlias(stripDiscordMentionNoise(alias)));
      for (const alias of aliases) {
        if (alias && !lookup.has(alias)) {
          lookup.set(alias, member);
        }
      }
    }
    return lookup;
  }

  resolveLeaderboardMember(row, memberLookup) {
    const candidates = [row.aliasNormalized, row.alias, row.leetifyName]
      .map((alias) => normalizeAlias(stripDiscordMentionNoise(alias)))
      .filter(Boolean);
    for (const candidate of candidates) {
      const member = memberLookup.get(candidate);
      if (member) {
        return member;
      }
    }
    return null;
  }

  async buildLeaderboardPayload(guildName = 'Server', guild = null) {
    const rows = this.getLeaderboardRows();
    const updatedAt = new Date();
    const title = `🏆 ${guildName} CS2 Leaderboard`;
    const memberLookup = await this.buildMemberLookup(guild);
    const description = rows.length === 0
      ? 'No linked players with cached ratings yet. Use `/link` and `/refresh` to populate the leaderboard.'
      : rows.map((row, index) => {
        const rank = index + 1;
        const member = this.resolveLeaderboardMember(row, memberLookup);
        const fallbackName = truncate(firstPresent(row.leetifyName, row.alias), 40);
        const mention = member ? `<@${member.id}>` : `**${fallbackName}**`;
        return `${medalForRank(rank)} ${mention} — ${formatRatingChip('Premier', row.premierRating)} · ${formatRatingChip('Leetify', row.leetifyRank)}`;
      }).join('\n');

    return {
      content: '',
      embeds: [{
        title,
        description,
        color: 0xf1c40f,
        fields: rows.length > 0 ? [{
          name: 'How this is sorted',
          value: 'Premier rating first, then Leetify rating. Mentions are resolved from saved aliases so names are clickable without pinging anyone.',
          inline: false
        }] : [],
        footer: { text: `Last updated ${updatedAt.toISOString()}` },
        timestamp: updatedAt.toISOString()
      }],
      allowedMentions: { parse: [] }
    };
  }

  async buildLeaderboardContent(guildName = 'Server', guild = null) {
    const payload = await this.buildLeaderboardPayload(guildName, guild);
    return payload.embeds[0]?.description || '';
  }

  async createOrUpdateLeaderboard(guildId, channel, guildName = 'Server') {
    this.initDb();
    const payload = await this.buildLeaderboardPayload(guildName, channel.guild || null);
    const existing = this.getLeaderboardRecord(guildId);

    if (existing && this.client) {
      try {
        const existingChannel = await this.client.channels.fetch(existing.channel_id);
        const existingMessage = await existingChannel.messages.fetch(existing.message_id);
        const message = await existingMessage.edit(payload);
        this.saveLeaderboardRecord(guildId, existing.channel_id, existing.message_id);
        return { message, created: false };
      } catch (error) {
        console.warn('[players] failed to update existing leaderboard, creating a new one:', summarizeError(error));
      }
    }

    const message = await channel.send(payload);
    this.saveLeaderboardRecord(guildId, message.channelId || channel.id, message.id);
    return { message, created: true };
  }

  async updateLeaderboard(guildId, guildName = 'Server') {
    this.initDb();
    if (!this.client) {
      return { updated: false, reason: 'Discord client is not ready.' };
    }

    const record = this.getLeaderboardRecord(guildId);
    if (!record) {
      return { updated: false, reason: 'No leaderboard has been created for this server yet. Run `/leaderboard` first.' };
    }

    const channel = await this.client.channels.fetch(record.channel_id);
    const guild = channel.guild || await this.client.guilds.fetch(guildId).catch(() => null);
    const payload = await this.buildLeaderboardPayload(guildName, guild);
    const message = await channel.messages.fetch(record.message_id);
    await message.edit(payload);
    this.saveLeaderboardRecord(record.guild_id, record.channel_id, record.message_id);
    return { updated: true, message };
  }

  async updateAllLeaderboards() {
    this.initDb();
    if (!this.client) {
      return { total: 0, updated: 0, failed: 0, skipped: true };
    }

    const records = this.getLeaderboardRecords();
    let updated = 0;
    let failed = 0;

    for (const record of records) {
      try {
        const channel = await this.client.channels.fetch(record.channel_id);
        const guild = channel.guild || await this.client.guilds.fetch(record.guild_id).catch(() => null);
        const payload = await this.buildLeaderboardPayload(guild?.name || 'Server', guild);
        const message = await channel.messages.fetch(record.message_id);
        await message.edit(payload);
        this.saveLeaderboardRecord(record.guild_id, record.channel_id, record.message_id);
        updated += 1;
      } catch (error) {
        failed += 1;
        console.warn(`[players] failed to update leaderboard for guild ${record.guild_id}:`, summarizeError(error));
      }
    }

    return { total: records.length, updated, failed };
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
        ranks_json = ?, rating_json = ?, stats_json = ?, latest_premier_game_json = ?, leetify_api_source = ?, updated_at = ?
      WHERE alias_normalized = ?
    `).run(
      metadata.premierRating || null,
      metadata.premierRating ? metadata.source : null,
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
      metadata.latestPremierGameJson || null,
      metadata.source || null,
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

  leetifyHeaders() {
    const headers = { accept: 'application/json' };
    if (this.leetifyApiKey) {
      headers.authorization = this.leetifyApiKey;
      headers._leetify_key = this.leetifyApiKey;
    }
    return headers;
  }

  async fetchLeetifyProfileMetadata(steamId64) {
    const publicUrl = new URL('/v3/profile', this.leetifyApiBase);
    publicUrl.searchParams.set('steam64_id', steamId64);
    try {
      const data = await this.fetchJson(publicUrl, this.leetifyHeaders());
      return extractLeetifyMetadata(data, 'leetify-public');
    } catch (error) {
      if (error?.code !== 'API_HTTP_ERROR' || error?.statusCode !== 404) {
        throw error;
      }
      console.warn(`[players] public Leetify profile returned 404 for ${steamId64}; trying legacy profile API.`);
    }

    const legacyUrl = new URL(`/api/profile/id/${encodeURIComponent(steamId64)}`, this.leetifyLegacyApiBase);
    const data = await this.fetchJson(legacyUrl, this.leetifyHeaders());
    return extractLeetifyMetadata(data, 'leetify-legacy');
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
            reject(new PlayerManagerError(`API request failed with HTTP ${response.statusCode}.`, { code: 'API_HTTP_ERROR', statusCode: response.statusCode }));
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
