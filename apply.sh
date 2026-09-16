 (cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF' 
diff --git a/README.md b/README.md
index 92fde423e44cf2ffd4499f4805f27c83516c80ed..bab134fcef4b56dbdfff385258e3fc5f5c849632 100644
--- a/README.md
+++ b/README.md
@@ -92,54 +92,56 @@ Copy `.env.example` to `.env`:
 - `AUDIO_QUEUE_MAX_MS` (optional, default `5000`; max decoded lobby-music PCM queued in memory)
 
 Notification scheduler is restart-safe: on startup, if today's daily message already exists, the bot reuses it and schedules the next run instead of reposting immediately.
 When the daily message rolls over, previous-day message metadata and interested rows are removed from SQLite (no unbounded growth).
 
 
 ## Player links and Premier ratings
 
 Use `/link alias:<name> url:<steam profile>` to store a local mapping in SQLite. The URL can be a `steamcommunity.com/profiles/<SteamID64>` URL or a `steamcommunity.com/id/<vanity>` URL. Vanity URLs require `STEAM_WEB_API_KEY` so the bot can call Steam `ResolveVanityURL`; direct SteamID64 profile URLs do not.
 
 Linking and refresh jobs call Leetify’s public `/v3/profile?steam64_id=<SteamID64>` endpoint first. If that returns 404, they fall back to `/api/profile/id/<SteamID64>` on `LEETIFY_LEGACY_API_BASE`; the fallback maps the first `games[]` item with `skillLevel` to the current Premier rating and stores that game separately. Both formats cache the player’s Premier rating plus normalized `ranks`, `rating`, and `stats` metadata when available. Linked players with a cached Premier rating render in draft dropdowns as `alias (11300)` style labels; unlinked players or players without a rating render normally.
 
 Rating refreshes happen in two ways:
 
 - Scheduled refresh: every `RATING_REFRESH_INTERVAL_HOURS` hours, the bot refreshes every linked player in the SQLite DB and re-renders any watched nickname templates that include `%rating%`.
 - Manual alias refresh: `/refresh alias:<name>` refreshes one linked player and returns the updated DB fields.
 - Manual voice refresh: `/refresh-voice` refreshes linked players currently in your voice call, useful immediately before starting a match.
 - Draft refresh: `/team-draft refresh_ratings:true` refreshes linked players currently in the voice call before the draft message is posted. This defaults to false to avoid surprising Leetify rate-limit usage. Refreshes are concurrency-limited to 3 in-flight API calls.
 
 Use `/leaderboard` to post the server leaderboard in the current channel. Only one leaderboard is tracked per guild; rerunning the command updates the existing tracked message when possible. Use `/refresh-leaderboard` to force-refresh the existing message after linking or refreshing players. The leaderboard displays player names, Premier ratings, and Leetify ratings; it sorts by Premier rating first and cached Leetify rating second, and updates after each scheduled all-player rating refresh. Legacy Leetify payloads read `recentGameRatings.leetify` directly and scale it into the displayed Leetify rating, so players without Premier can still show a Leetify rating when available.
 
 Inspect a stored mapping with `/get-info alias:<name>`, which returns the DB fields plus cached Leetify source, ranks/rating/stats, and latest Premier game Discord-side for quick verification. Remove a mapping with `/unlink alias:<name>`.
 
 ### Rating nickname variables
 
-Members can opt into a rendered rating nickname by adding `%rating%` to their server nickname after they have a matching `/link` alias. For example, changing your nickname to `chomes -- %rating%` stores that template and immediately renders it as `chomes -- 17333` when the linked `chomes` alias has a cached Premier rating of `17333`.
+Members can opt into a rendered rating nickname by adding `%rating%` to their server nickname after they have run `/link`. The bot first uses the Discord member who created the link, then falls back to matching the nickname text before `%rating%` against a linked alias. For example, changing your nickname to `chomes -- %rating%` stores that template and immediately renders it as `chomes -- 17333` when your linked account (or the linked `chomes` alias) has a cached Premier rating of `17333`.
 
 The bot stores the original nickname template per guild/user in SQLite, along with a `watch_rating` flag. The rendered nickname is remembered separately so the bot can ignore its own follow-up `GuildMemberUpdate` event, while a user changing to a plain nickname removes the watch. Each scheduled rating refresh re-renders all rows with `watch_rating = 1`, so rating changes are reflected without losing the original `%rating%` template. Future variables can add their own watch column and renderer without changing the storage shape.
 
+Discord only allows this when the bot has **Manage Nicknames** and its highest role is above the member it is editing; Discord still blocks server owners and members with equal-or-higher roles. If no member-owned link or nickname alias matches, the bot stores the template but leaves the member's nickname untouched until a matching `/link` exists.
+
 ## Invite the Bot User to Your Server
 
 If you only installed the **application command integration**, Discord can show just the app without a bot user in member list.
 You must invite with the **bot** scope as well.
 
 In Discord Developer Portal → OAuth2 → URL Generator:
 
 - Scopes:
   - `bot`
   - `applications.commands`
 - Bot permissions:
   - Manage Roles
   - Manage Channels
   - Move Members
   - Connect
   - View Channels
 
 Then open the generated URL and add the bot to your server.
 
 ## Local Run
 
 ```bash
 npm install
 cp .env.example .env
 # edit .env
diff --git a/src/index.js b/src/index.js
index cc839509b747e0d4a3e43b6f206a6e00d3d48ec1..f59f2db3956dea2cbe72d397b800f4ccc9aff528 100644
--- a/src/index.js
+++ b/src/index.js
@@ -497,51 +497,52 @@ client.once(Events.ClientReady, async (readyClient) => {
   await notificationManager.start();
 });
 
 client.on(Events.InteractionCreate, async (interaction) => {
   try {
     if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.TEAM_DRAFT.name) {
       await draftManager.startDraft(interaction, config);
       return;
     }
 
     if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.TEAM_DRAFT_MOCK.name) {
       const players = interaction.options.getInteger(COMMANDS.TEAM_DRAFT_MOCK.options.PLAYERS.name, true);
       const spawnVoice = interaction.options.getBoolean(COMMANDS.TEAM_DRAFT_MOCK.options.SPAWN_VOICE.name) ?? true;
       const broadcast = interaction.options.getBoolean(COMMANDS.TEAM_DRAFT_MOCK.options.BROADCAST.name) ?? true;
       const draftType = interaction.options.getString(COMMANDS.TEAM_DRAFT_MOCK.options.DRAFT_TYPE.name) ?? DRAFT_TYPE_CHOICES.SNAKE.value;
       await draftManager.runMockDraft(interaction, players, config, spawnVoice, broadcast, draftType);
       return;
     }
 
 
     if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.LINK.name) {
       await interaction.deferReply({ flags: MessageFlags.Ephemeral });
       try {
         const linked = await playerManager.link(
           interaction.options.getString(COMMANDS.LINK.options.ALIAS.name, true),
-          interaction.options.getString(COMMANDS.LINK.options.URL.name, true)
+          interaction.options.getString(COMMANDS.LINK.options.URL.name, true),
+          { discordUserId: interaction.user.id, discordGuildId: interaction.guildId }
         );
         await interaction.editReply({
           content: linked.premier_rating
             ? `Linked \`${linked.alias}\` to SteamID64 \`${linked.steam_id64}\` with Premier rating **${linked.premier_rating}**.`
             : `Linked \`${linked.alias}\` to SteamID64 \`${linked.steam_id64}\`. No Premier rating was available yet.`
         });
       } catch (error) {
         console.error('Failed to link player:', summarizePlayerError(error));
         await interaction.editReply({ content: error.message || 'Failed to link player.' });
       }
       return;
     }
 
     if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.UNLINK.name) {
       const alias = interaction.options.getString(COMMANDS.UNLINK.options.ALIAS.name, true);
       const removed = playerManager.unlink(alias);
       await interaction.reply({
         content: removed ? `Unlinked \`${alias}\`.` : `No link found for \`${alias}\`.`,
         flags: MessageFlags.Ephemeral
       });
       return;
     }
 
     if (interaction.isChatInputCommand() && interaction.commandName === COMMANDS.GET_INFO.name) {
       const alias = interaction.options.getString(COMMANDS.GET_INFO.options.ALIAS.name, true);
@@ -768,50 +769,45 @@ client.on(Events.InteractionCreate, async (interaction) => {
       await draftManager.handleStartDraftButton(interaction, config);
       return;
     }
 
     if (interaction.isButton() && interaction.customId.startsWith('draftabort:')) {
       await draftManager.handleAbortDraftButton(interaction);
       return;
     }
 
     if (notificationManager.isEnabled() && interaction.isButton() && interaction.customId.startsWith('cs2_')) {
       await notificationManager.handleButton(interaction);
     }
   } catch (error) {
     console.error('Interaction error:', error);
     if (interaction.deferred || interaction.replied) {
       await interaction.followUp({ content: 'Something went wrong handling that interaction.', flags: MessageFlags.Ephemeral }).catch(() => {});
     } else {
       await interaction.reply({ content: 'Something went wrong handling that interaction.', flags: MessageFlags.Ephemeral }).catch(() => {});
     }
   }
 });
 
 
 client.on(Events.Raw, (packet) => {
   logVoiceGatewayPacket(packet, client.user?.id);
-  if (packet?.t === 'GUILD_MEMBER_UPDATE') {
-    playerManager.handleRawGuildMemberUpdate(packet).catch((error) => {
-      console.error('Raw nickname variable update error:', summarizePlayerError(error));
-    });
-  }
 });
 
 client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
   try {
     await draftManager.handleVoiceStateUpdate(oldState, newState);
     await announcementManager.handleVoiceStateUpdate(oldState, newState);
   } catch (error) {
     console.error('Voice cleanup error:', error);
   }
 });
 
 client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
   try {
     await playerManager.handleMemberNicknameUpdate(oldMember, newMember);
   } catch (error) {
     console.error('Nickname variable update error:', summarizePlayerError(error));
   }
 });
 
 client.login(token);
diff --git a/src/playerManager.js b/src/playerManager.js
index 95d76bc78d58f6b8d3601adcc699028eb2767871..d69f19aad01fe95e9c44171b57a9ac6d9e196e4c 100644
--- a/src/playerManager.js
+++ b/src/playerManager.js
@@ -32,50 +32,54 @@ class PlayerManagerError extends Error {
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
 
+function isMissingPermissionsError(error) {
+  return error?.code === 50013 || error?.code === '50013' || error?.rawError?.code === 50013;
+}
+
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
 
@@ -413,231 +417,272 @@ class PlayerManager {
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
+        discord_user_id TEXT,
+        discord_guild_id TEXT,
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
+    this.db.exec(`
+      CREATE INDEX IF NOT EXISTS idx_player_links_discord_user_id ON player_links(discord_user_id);
+      CREATE INDEX IF NOT EXISTS idx_player_links_discord_member ON player_links(discord_guild_id, discord_user_id);
+    `);
     this.addMissingNicknameTemplateColumns();
   }
 
   addMissingPlayerLinkColumns() {
     const existingColumns = new Set(this.db.prepare('PRAGMA table_info(player_links)').all().map((column) => column.name));
     const columns = {
+      discord_user_id: 'TEXT',
+      discord_guild_id: 'TEXT',
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
 
-  async link(alias, steamProfileUrl) {
+  async link(alias, steamProfileUrl, owner = {}) {
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
 
+    const discordUserId = owner?.discordUserId ? String(owner.discordUserId) : null;
+    const discordGuildId = owner?.discordGuildId ? String(owner.discordGuildId) : null;
     const now = new Date().toISOString();
     this.db.prepare(`
       INSERT INTO player_links (
-        alias, alias_normalized, steam_profile_url, steam_id64, premier_rating, rating_source, rating_updated_at,
+        alias, alias_normalized, steam_profile_url, steam_id64, discord_user_id, discord_guild_id, premier_rating, rating_source, rating_updated_at,
         leetify_profile_name, leetify_profile_id, privacy_mode, total_matches, winrate, first_match_date, ranks_json, rating_json, stats_json, latest_premier_game_json, leetify_api_source, updated_at
       )
-      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
+      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(alias_normalized) DO UPDATE SET
         alias = excluded.alias,
         steam_profile_url = excluded.steam_profile_url,
         steam_id64 = excluded.steam_id64,
+        discord_user_id = excluded.discord_user_id,
+        discord_guild_id = excluded.discord_guild_id,
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
+      discordUserId,
+      discordGuildId,
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
 
+  getByDiscordMember(member) {
+    this.initDb();
+    const userId = member?.id || member?.user?.id;
+    if (!userId) {
+      return null;
+    }
+
+    const guildId = member?.guild?.id || null;
+    if (guildId) {
+      const guildLink = this.db.prepare(`
+        SELECT * FROM player_links
+        WHERE discord_user_id = ? AND (discord_guild_id = ? OR discord_guild_id IS NULL)
+        ORDER BY discord_guild_id IS NULL ASC, updated_at DESC
+      `).get(String(userId), String(guildId));
+      if (guildLink) {
+        return guildLink;
+      }
+    }
+
+    return this.db.prepare('SELECT * FROM player_links WHERE discord_user_id = ? ORDER BY updated_at DESC').get(String(userId)) || null;
+  }
+
   getAll() {
     this.initDb();
     return this.db.prepare('SELECT * FROM player_links ORDER BY alias COLLATE NOCASE').all();
   }
 
   getLinkForMember(member) {
     this.initDb();
+    const memberLink = this.getByDiscordMember(member);
+    if (memberLink) {
+      return memberLink;
+    }
+
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
@@ -649,113 +694,131 @@ class PlayerManager {
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
+    const memberLink = this.getByDiscordMember(member);
+    if (memberLink) {
+      return memberLink;
+    }
+
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
 
-    await member.setNickname(renderedNickname || null, 'Rendered tracked nickname variables');
-    return true;
+    try {
+      await member.setNickname(renderedNickname || null, 'Rendered tracked nickname variables');
+      return true;
+    } catch (error) {
+      if (isMissingPermissionsError(error)) {
+        console.warn(
+          `[players] cannot update nickname for ${member.guild?.id || 'unknown-guild'}/${member.id}: `
+          + 'Discord denied Manage Nicknames/role hierarchy permissions.'
+        );
+        return false;
+      }
+      throw error;
+    }
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
-      console.warn(`[players] nickname variables configured for ${member.id}, but no player link matched '${normalizedNickname}'.`);
+      const candidates = this.nicknameAliasCandidates(member, normalizedNickname, previousMember).join(', ');
+      console.warn(`[players] nickname variables configured for ${member.id}, but no player link matched '${normalizedNickname}' (tried: ${candidates || 'none'}).`);
+      return { action: 'saved_unmatched', renderedNickname, matched: false };
     }
 
     await this.applyRenderedNickname(member, renderedNickname);
-    return { action: 'saved', renderedNickname, matched: Boolean(link) };
+    return { action: 'saved', renderedNickname, matched: true };
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
 
EOF
)