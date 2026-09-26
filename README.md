# CS2 Team Draft Discord Bot

A Discord bot that runs a random-captain team draft from a voice channel, creates private temporary team voice channels, moves players automatically, and cleans up channels/roles when everyone leaves.

## Features

- `/team-draft` slash command
- `/team-draft players:<optional even number> captain1:<@user> captain2:<@user> draft_type:<snake|regular>` to set total drafted players, manually pick captains, and choose draft order (default `snake`; captains must be in same voice channel)
- `/team-draft-mock players:<even number> [spawn_voice:true|false] [broadcast:true|false] [draft_type:snake|regular]` for solo testing with fake users; it simulates picks with voice narration timing, switches to `final_countdown.mp3`, and posts a **Start Mock Match** button that plays `fight.mp3`/TTS, optionally creates/moves you to mock voice, then disconnects audio
- `/link alias:<name> url:<steam profile>` to store an alias → Steam profile mapping and cache the player Premier rating
- `/unlink alias:<name>` to remove a stored alias mapping
- `/get-info alias:<name>` to inspect the stored DB record for an alias from Discord
- `/refresh alias:<name>` to refresh one linked player’s Leetify Premier metadata
- `/refresh-voice` to refresh linked players in your current voice channel before starting a match
- `/leaderboard` to create or update the one maintained ratings leaderboard message for the server
- `/refresh-leaderboard` to refresh the existing maintained leaderboard after linking or refreshing players
- `/draft-status` to inspect active draft/mock resources
- `/draft-cancel` to cancel active draft and cleanup resources
- `/draft-cleanup` to force cleanup resources if something gets stuck
- `/return-to-voice` to move drafted players back to original draft voice channel and cleanup draft resources
- `/build-version` to show the running build commit hash/version
- `/test-lobby-music` to join your voice channel and test draft lobby music
- `/test-tts message:<text>` to test voice text-to-speech in the current voice channel
- `/announce alias:<@user> filename:<file.mp3>` to save a voice-join announcement MP3 for a user; announcements are skipped while a draft is active and rate-limited after voice leaves
- `/remove-announcement alias:<@user>` to delete a saved voice-join announcement so the user no longer triggers one
- `/reset-announce-timer alias:<@user>` to clear a saved announcement cooldown for testing the next fresh voice join
- `/audio-status` to show the current voice connection state, queued speech duration, and `@discordjs/voice` dependency report
- Both commands are server-only (not available in DMs)
- `/team-draft` updates are broadcast in the channel message for everyone; mock defaults to broadcast too
- Dynamic team size from current voice member count (must be even)
  - 8 players => 4v4
  - 10 players => 5v5
- Random captain assignment
- Snake draft pick flow by default, with an optional regular alternating draft order
- Draft pick updates are collected in the draft embed history instead of separate chat messages; back-to-back snake picks by the same captain are combined into one voice announcement
- Draft completion keeps **Start** (green button) and **Cancel** (red button) on the main draft embed to create/move players or abort
- Private temporary voice channels per team using temporary roles
- Automatic cleanup when team channels empty
- Optional daily CS2 notification message at configurable CST/CDT time (default 6:00 PM) with Interested / Not Interested / Subscribe / Unsubscribe buttons
- Optional draft lobby music from `/app/data/lobby.mp3` plus voice TTS pick announcements during drafts
  - Clicking Interested also auto-adds the notification role if missing

## Requirements

- Node.js 20+
- The bundled Docker image installs `opusscript` plus `@noble/ciphers` and uses `@discordjs/voice` 0.19+ so modern Discord voice gateway/DAVE encryption handshakes are supported.
- Discord bot with these permissions:
  - Manage Roles
  - Manage Channels
  - Move Members
  - Connect / View Channels
- Discord install scopes/permissions:
  - Guild Install should include `bot` and `applications.commands`.
  - Administrator is sufficient for channel permissions, but you can also explicitly grant Manage Roles, Manage Channels, Move Members, Connect, View Channels, and Speak.
- Discord intent requirements:
  - The code requests `GuildVoiceStates`; this is required for Discord voice connections and is not replaced by Administrator permissions.
  - Enable **Server Members Intent** in Discord Developer Portal for draft player/member lookup.

## Environment Variables

Copy `.env.example` to `.env`:

- `DISCORD_TOKEN` (required)
- `DISCORD_GUILD_ID` (optional, recommended for fast slash command registration; supports comma-separated guild IDs)
- `KEEP_GLOBAL_COMMANDS` (optional, default `false`; set `true` only if you intentionally want both global and guild commands)
- `TEAM_CATEGORY_ID` (optional category ID for team channels)
- `TEAM_NAMES` (optional comma-separated random team voice names, e.g. `Musty Mango,Dusty Devils,Blueball Warriors`)
- `MIN_PLAYERS` (optional, default `4`)
- `NOTIFICATION_CHANNEL_ID` (optional channel ID for daily queue notification message)
- `NOTIFICATION_ROLE_ID` (optional role ID to mention and manage via subscribe buttons)
- `NOTIFICATION_TIME_CST` (optional, default `18:00`; daily post time in America/Chicago timezone)
- `SQLITE_PATH` (optional, default `/app/data/bot.db`; persisted notification/player-link/announcement SQLite database file)
- `STEAM_WEB_API_KEY` (optional unless linking `steamcommunity.com/id/...` vanity URLs; used with Steam ResolveVanityURL)
- `LEETIFY_API_KEY` (optional; public Leetify profile refreshes work without it, but if set it is sent as the documented `Authorization`/`_leetify_key` header value)
- `LEETIFY_API_BASE` (optional, default `https://api-public.cs-prod.leetify.com`; override only if Leetify changes the public API host)
- `LEETIFY_LEGACY_API_BASE` (optional, default `https://api.cs-prod.leetify.com`; fallback host for `/api/profile/id/<SteamID64>` when the public profile endpoint returns 404)
- `RATING_REFRESH_INTERVAL_HOURS` (optional, default `24`; scheduled refresh interval for every linked player’s cached Premier rating)
- `ANNOUNCEMENT_AUDIO_DIRECTORY` (optional, defaults to the directory containing `LOBBY_MUSIC_PATH`; stores MP3 files referenced by `/announce`)
- `ANNOUNCEMENT_COOLDOWN_MS` (optional, default `600000`; minimum time after a mapped user leaves voice before another join announcement may play)
- `BUILD_VERSION` (optional, default `dev`; set automatically in Docker CI to commit SHA)
- `BUILD_DATE` (optional, default `unknown`; set automatically in Docker CI to commit date)
- `LOBBY_MUSIC_PATH` (optional, default `/app/data/lobby.mp3`; MP3 file for draft lobby music)
- `LOBBY_MUSIC_VOLUME` (optional, default `0.35`; normal music volume. Accepts ratios like `0.25`, percentages like `25%`, or whole-number percentages like `25`.)
- `TTS_MUSIC_DUCK_VOLUME` (optional, default `0.12`; temporary music volume while TTS is speaking. Accepts the same formats as `LOBBY_MUSIC_VOLUME`.)
- `AUDIO_DEBUG` (optional, default `false`; set `true` for extra verbose voice/TTS diagnostics including HTTP and ffmpeg byte counts)
- `VOICE_SELF_DEAF` (optional, default `false`; set `true` if you want the bot to join self-deafened like many music bots)
- `GOOGLE_TTS_LANG` (optional, default `en`; Google Translate TTS language/accent code such as `en`, `en-GB`, `en-AU`, `es`, `fr`, `de`, or `ja`)
- `GOOGLE_TTS_SLOW` (optional, default `false`; set `true` for slower speech)
- `GOOGLE_TTS_HOST` (optional, default `https://translate.google.com`; override for regional Translate hosts such as `https://translate.google.com.cn`)
- `AUDIO_BUFFER_MS` (optional, default `500`; lobby-music PCM prebuffer to smooth jitter; increase to `1000` if music sputters)
- `AUDIO_QUEUE_MAX_MS` (optional, default `5000`; max decoded lobby-music PCM queued in memory)

Notification scheduler is restart-safe: on startup, if today's daily message already exists, the bot reuses it and schedules the next run instead of reposting immediately.
When the daily message rolls over, previous-day message metadata and interested rows are removed from SQLite (no unbounded growth).


## Player links and Premier ratings

Use `/link alias:<name> url:<steam profile>` to store a local mapping in SQLite. The URL can be a `steamcommunity.com/profiles/<SteamID64>` URL or a `steamcommunity.com/id/<vanity>` URL. Vanity URLs require `STEAM_WEB_API_KEY` so the bot can call Steam `ResolveVanityURL`; direct SteamID64 profile URLs do not.

Linking and refresh jobs call Leetify’s public `/v3/profile?steam64_id=<SteamID64>` endpoint first. If that returns 404, they fall back to `/api/profile/id/<SteamID64>` on `LEETIFY_LEGACY_API_BASE`; the fallback maps the first `games[]` item with `skillLevel` to the current Premier rating and stores that game separately. Both formats cache the player’s Premier rating plus normalized `ranks`, `rating`, and `stats` metadata when available. Linked players with a cached Premier rating render in draft dropdowns as `alias (11300)` style labels; unlinked players or players without a rating render normally.

Rating refreshes happen in two ways:

- Scheduled refresh: every `RATING_REFRESH_INTERVAL_HOURS` hours, the bot refreshes every linked player in the SQLite DB.
- Manual alias refresh: `/refresh alias:<name>` refreshes one linked player and returns the updated DB fields.
- Manual voice refresh: `/refresh-voice` refreshes linked players currently in your voice call, useful immediately before starting a match.
- Draft refresh: `/team-draft refresh_ratings:true` refreshes linked players currently in the voice call before the draft message is posted. This defaults to false to avoid surprising Leetify rate-limit usage. Refreshes are concurrency-limited to 3 in-flight API calls.

Use `/leaderboard` to post the server leaderboard in the current channel. Only one leaderboard is tracked per guild; rerunning the command updates the existing tracked message when possible. Use `/refresh-leaderboard` to force-refresh the existing message after linking or refreshing players. The leaderboard displays player names, Premier ratings, and Leetify ratings; it sorts by Premier rating first and cached Leetify rating second, and updates after each scheduled all-player rating refresh. Legacy Leetify payloads read `recentGameRatings.leetify` directly and scale it into the displayed Leetify rating, so players without Premier can still show a Leetify rating when available.

Inspect a stored mapping with `/get-info alias:<name>`, which returns the DB fields plus cached Leetify source, ranks/rating/stats, and latest Premier game Discord-side for quick verification. Remove a mapping with `/unlink alias:<name>`.

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
npm start
```

## Docker (Unraid Friendly)

Build image:

```bash
docker build -t cs2-team-draft-bot:latest .
```

Run container:

```bash
docker run -d \
  --name cs2-team-draft-bot \
  --restart unless-stopped \
  -v /path/on/host/10man-bot-data:/app/data \
  --env-file /path/to/.env \
  cs2-team-draft-bot:latest
```

SQLite file location in container: `/app/data/bot.db` (or your custom `SQLITE_PATH`). The Docker entrypoint fixes ownership of `/app/data` before dropping to the non-root `node` user, so bind mounts/named volumes should remain writable by SQLite.

Draft lobby music file location in container: `/app/data/lobby.mp3` (or your custom `LOBBY_MUSIC_PATH`). If the file is missing, the bot still joins voice and uses TTS pick announcements without music. Put `final_countdown.mp3` and `fight.mp3` in the same directory as `lobby.mp3` to enable the post-draft and start-match music cues; all three tracks obey `LOBBY_MUSIC_VOLUME`, and automatically duck to `TTS_MUSIC_DUCK_VOLUME` while TTS is speaking. If `fight.mp3` is missing, the bot falls back to TTS saying `fight! fight! fight!`. `/announce` files also default to this same directory unless `ANNOUNCEMENT_AUDIO_DIRECTORY` is set. The Docker image includes FFmpeg and the `opusscript` Opus encoder dependency needed for Discord voice playback, so `/test-lobby-music`, `/test-tts`, and announcement playback need no host FFmpeg or Opus setup.


## Audio smoothness tuning

The bot mixes raw PCM audio before handing it to Discord voice. Lobby, final-countdown, and fight music default to 35% volume (`LOBBY_MUSIC_VOLUME=0.35`) and duck to 12% volume (`TTS_MUSIC_DUCK_VOLUME=0.12`) while TTS is speaking. Music and TTS use the system `ffmpeg` binary (or `FFMPEG_PATH` if set). For lobby music, it throttles ffmpeg with `-re`, prebuffers decoded PCM before releasing music frames, respects stream backpressure, and caps the decoded music queue to avoid unbounded memory/GC spikes. If music still sputters, try increasing `AUDIO_BUFFER_MS` to `1000` or `1500`; this adds startup latency but gives the mixer more room to absorb host or event-loop jitter.

## Google TTS voice/language options

This bot currently uses the unofficial `google-tts-api` package, which wraps Google Translate TTS. That package does **not** expose named voices like `en-US-Wavenet-D`; it only supports language/accent selection through `lang`, a `slow` speed toggle, and a Translate `host` override. Use `GOOGLE_TTS_LANG` to change the voice/accent. Common examples:

- English/default: `GOOGLE_TTS_LANG=en`
- British English: `GOOGLE_TTS_LANG=en-GB`
- Australian English: `GOOGLE_TTS_LANG=en-AU`
- Spanish: `GOOGLE_TTS_LANG=es`
- French: `GOOGLE_TTS_LANG=fr`
- German: `GOOGLE_TTS_LANG=de`
- Japanese: `GOOGLE_TTS_LANG=ja`

For a larger list, use Google Cloud's language-code docs as a reference for BCP-47 language tags. Not every Cloud TTS named voice is available through Google Translate TTS; if you want named Google voices (Standard/WaveNet/Neural2/Studio), this bot would need to switch from `google-tts-api` to the paid Google Cloud Text-to-Speech API.

## GitHub Action: Build + Push to Docker Hub

A workflow is included at `.github/workflows/docker-publish.yml` and runs on every branch push, every pull request update, and manual `workflow_dispatch` runs. Running on branch pushes is intentional: newly added workflows may not appear for an already-open PR until another push happens or until the workflow exists on the base branch, so the branch-push trigger still publishes an image you can test immediately.

Set these GitHub repo secrets:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN` (Docker Hub access token)
- `DOCKERHUB_IMAGE_NAME` (optional, e.g. `yourname/10man-discord-bot`; defaults to `DOCKERHUB_USERNAME/10man-discord-bot`)

Published tags:

- Pushes to `main`: `latest` and `sha-<short-commit>`.
- Pushes to other branches: `branch-<branch-name>` and `sha-<short-commit>`.
- Pull requests: `pr-<number>` and `sha-<short-commit>`.
- Manual runs: `sha-<short-commit>`.

For PR testing, push your branch and wait for the **Docker Publish** workflow to finish. If the `pull_request` event runs, the workflow writes the pushed image tags to the job summary and posts/updates a PR comment with the exact Docker image tags you can run on your server. If GitHub does not show a PR run yet, use the branch image tag from the branch-push run instead (for example, `branch-work`). Example:

```bash
docker pull yourname/10man-discord-bot:pr-123
# Or, if only the branch-push run appears:
# docker pull yourname/10man-discord-bot:branch-work

docker run -d \
  --name cs2-team-draft-bot-pr-123 \
  --restart unless-stopped \
  -v /path/on/host/10man-bot-data:/app/data \
  --env-file /path/to/.env \
  yourname/10man-discord-bot:pr-123
# Or use your branch tag, e.g. yourname/10man-discord-bot:branch-work
```

### Suggested Unraid container settings

- Repository: image you build/push
- Network type: bridge
- Restart policy: unless-stopped
- Variables:
  - `DISCORD_TOKEN`
  - `DISCORD_GUILD_ID` (optional)
  - `TEAM_CATEGORY_ID` (optional)
  - `TEAM_NAMES` (optional)
  - `MIN_PLAYERS` (optional)
  - `LOBBY_MUSIC_PATH` (optional)

## Notes

- If a draft is active in a guild, additional `/team-draft` calls are blocked.
- Bot ignores bot accounts when counting eligible players.
- Team channels are intentionally hidden cross-team.
- Mock drafts can optionally create a temporary private voice test channel and move you there (`spawn_voice`, default `true`).

## Streaming selfbot (Mode B)

This image ships the CS2 app bot (`src/index.js`) and one or more TV streaming workers (`src/streambot/index.js`) in one container. Switch or run both via the `MODE` env var (see `run.sh`):

- `MODE=bot` (or unset) — run the CS2 real-bot only. Legacy behavior, unchanged.
- `MODE=streambot` — run the streaming worker supervisor only. Requires one Discord **user** token per worker and a `libzmq`-capable `ffmpeg` on the container's `$PATH`.
- `MODE=all` — run the app bot and streaming workers concurrently.

The app bot accepts `/stream` and `/player`, then sends authenticated WebSocket commands to the selected worker. Workers initiate the connection, so workers in the same container need no extra published port. Set one shared `STREAM_BROKER_SECRET`; the local broker URL defaults to `ws://127.0.0.1:8090`.

The optional React control room runs in the CS app bot process when `STREAM_BROKER_SECRET` and `SECRET_ANSWER` are set. Set `SECRET_QUESTION` to the prompt shown at login (for example, `What is Alex's nickname?`), and `SECRET_ANSWER` to the answer. Answers are case-insensitive. `STREAM_DASHBOARD_TOKEN` remains supported as a legacy password when `SECRET_ANSWER` is unset. Publish `-p 8082:8082` (or your chosen `STREAM_DASHBOARD_PORT`) and open `http://<server>:8082`. After answering, you can see all configured workers, current media, queue, voice channels, and playback stats. You can play, pause, seek, stop, drag queued videos to reorder, join or switch voice channels, and change a worker's name. Name changes try the account's global display name, then fall back to a server nickname through the CS bot. Use HTTPS when accessing it outside a trusted LAN. The dashboard is disabled when neither answer nor legacy password is set.

Set `STREAM_DASHBOARD_CHANNEL_IDS=123456789012345678,234567890123456789` to show only those voice channels in the dashboard dropdown. Channel names still come from Discord. Leave it empty to show all visible voice channels; the manual ID dialog works regardless of this filter.

The dashboard can remove queued videos without interrupting the current stream. For Jellyfin `/Items/<id>/Download` URLs, the worker also tries a short, same-server item metadata lookup for title, runtime, and artwork; video playback still uses yt-dlp and proceeds if metadata is unavailable. Jellyfin artwork URLs may contain the same API key as the supplied media URL so the browser can load them.

Click a worker in the dashboard sidebar to open its expanded player. Its URL uses `#/worker/<worker-id>`, so you can bookmark or share a direct link to that worker.

The Docker build bundles the React app automatically. For a local non-Docker run, build it once with `npm ci --prefix web && npm run build --prefix web` before starting the CS bot.

For multiple workers in one container, set:

```dotenv
STREAMBOT_IDS=primary,youtube
SELF_BOT_TOKEN_PRIMARY=...
SELF_BOT_TOKEN_YOUTUBE=...
SBOT_CHAT_COMMANDS_PRIMARY=true
SBOT_CHAT_COMMANDS_YOUTUBE=false
```

An omitted `bot` option targets `STREAMBOT_DEFAULT_ID` (`primary` by default). Every `/stream` subcommand exposes an autocompleted optional `bot` option. `/player [bot]` opens pause, resume, and ±5s/±30s/±1m controls. `/set-stream-name name:<name> [bot]` asks the CS app bot to change the selected worker's nickname in the server where the command is used. The CS bot needs **Manage Nicknames**, and its highest role must be above the streambot's highest role. `STREAM_ALLOWED_USER_IDS` restricts these app-bot controls; when unset, all server members may use them. It is independent from the `$`-only `SBOT_ALLOWED_USER_IDS`. See `streambot.env.example` for the full worker configuration.

The selfbot streams H.264 by default into a Discord voice channel via the selfbot user-token path. Arc VAAPI H.265 and AV1 are opt-in with `VIDEO_CODEC=h265` or `VIDEO_CODEC=av1` plus `STREAMBOT_VIDEO_ENCODER=vaapi`; test client compatibility before using either for a group. This is ToS-adjacent; use a dedicated/throwaway Discord account, never a token used elsewhere, and do not run both apps on the same Discord account.

### Selfbot commands (in-channel, prefix `$` by default)
The primary worker keeps these legacy cross-server commands enabled by default. Secondary workers default to broker-only. Override either worker with `SBOT_CHAT_COMMANDS_<WORKER_ID>=true|false`; hyphens in IDs become underscores in the env suffix. When multiple workers listen for chat commands, an unqualified command such as `$join` executes only on `STREAMBOT_DEFAULT_ID` (`primary` by default). Add a colon suffix to target another worker: `$join:youtube`, `$stream:youtube <url>`, `$scrub:youtube +30s`, and so on. Each listener ignores commands addressed to another worker, preventing duplicate execution.

- `$stream <url>` — start streaming a URL. The URL can be:
  - a **ShareTV slug** or `/s/<slug>` link (resolved via `SHARETV_BASE/api/public/share/:slug`, prefers `hls_url`)
  - a **direct** media URL (`.m3u8` / `.ts` / `.mp4` / `.mkv`)
  - any **yt-dlp**-support URL (YouTube, Twitch, Vimeo, Facebook, news sites, …). `yt-dlp` must be on the container `PATH` (or set `YTDLP_PATH`).
- `$stream stop` / `$stop` — stop and leave voice.
- `$stream status` / `$status` — current stream summary.
- `$ping` — liveness echo.

### Inbound webhook (for IPTV-Share / ShareTV to POST a trigger)
- `POST /webhook/stream` on `:8081` (per `STREAMBOT_WEBHOOK_PORT`), with body (structured or legacy Discord-webhook shape — both accepted) and HMAC header:
  ```
  x-webhook-secret: $(printf '%s' '<raw body>' | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}')
  ```
- `GET /health` → `{"ok":true,"service":"streambot","streaming":<bool>}`
- `GET /webhook/help` → schema doc.

**The outbound side of the webhook is implemented in the `iptv-share` repo.** A prompt describing that change is in `docs/iptv-share-prompt-for-outbound-webhook.md` in this repo.

### GPU decode (optional)
Set `HARDWARE_ACCEL=true` and bind a GPU render node at deploy time. The video lib defaults to `/dev/dri/renderD128`; override with your render node if different:
```
docker run ... --device /dev/dri/renderD128 ...
```
`FFMPEG_PATH` must point to an ffmpeg that has `vaapi` support (`ffmpeg -hwaccels` should list `vaapi`).

## Troubleshooting

- **Bot says `yt-dlp could not resolve that URL` on an iptv-share link** — set `SHARETV_BASE` to a base URL that is *reachable from the bot* (not your browser/host). Inside Docker use `http://host.docker.internal:8080` (Mac/Win) or the compose service name / host LAN IP (Linux). A bare slug (`$stream dlp-test`) works the same way once `SHARETV_BASE` is set.
- If you see `Error: Used disallowed intents`, enable **Server Members Intent** in your bot settings in the Discord Developer Portal.
- If `/team-draft` says it must be used in a server, re-invite/update the bot commands and run it in a guild text channel (not a DM/app home).
- If mock voice says it is not in server context, the command is being executed outside a guild context (or stale command registration). Re-register commands and run from a server text channel.
- If new/updated commands do not appear, set `DISCORD_GUILD_ID` and restart bot; global command updates can take up to ~1 hour to propagate.
- If commands appear twice, you likely have both global and guild registrations. Keep `DISCORD_GUILD_ID` set and leave `KEEP_GLOBAL_COMMANDS` unset/`false` so startup clears globals.
- If logs show the voice WebSocket receives Opcode 8 Hello and then falls back to `signalling`, make sure you rebuilt with `@discordjs/voice` 0.19+ and `@noble/ciphers`; Discord's modern voice gateway/DAVE flow can reject older voice clients before audio reaches `Ready`. If voice tests join the channel but logs say the connection did not report `Ready`, the bot now keeps the voice session alive and queues audio instead of disconnecting. If audio still never plays, run `/audio-status`; if the connection is not `ready`, verify the bot has the **GuildVoiceStates** gateway intent in code, **Speak** permission in the channel, and that the host/container can make outbound UDP connections to Discord voice servers. Admin permissions do not replace required gateway events or network connectivity. The bot no longer joins self-deafened by default; set `VOICE_SELF_DEAF=true` only if you want that music-bot behavior. With `AUDIO_DEBUG=true`, the bot also logs raw `VOICE_STATE_UPDATE` for itself and `VOICE_SERVER_UPDATE`; both are required before `@discordjs/voice` can leave `signalling`. Set `AUDIO_DEBUG=true` to log each TTS step (request received, Google TTS HTTP response, MP3 byte count, ffmpeg decode byte count, PCM queue length, voice connection status, and audio player status). TTS speech is now held in the queue until Discord voice reaches `Ready`; if it stays `signalling`/`connecting`, the queue will remain non-zero and the issue is the voice transport rather than Google TTS or ffmpeg.
