# CS2 Team Draft Discord Bot

A Discord bot that runs a random-captain snake draft from a voice channel, creates private temporary team voice channels, moves players automatically, and cleans up channels/roles when everyone leaves.

## Features

- `/team-draft` slash command
- `/team-draft players:<optional even number> captain1:<@user> captain2:<@user>` to set total drafted players and/or manually pick captains (captains must be in same voice channel)
- `/team-draft-mock players:<even number> [spawn_voice:true|false] [broadcast:true|false]` for solo testing with fake users
- `/draft-status` to inspect active draft/mock resources
- `/draft-cancel` to cancel active draft and cleanup resources
- `/draft-cleanup` to force cleanup resources if something gets stuck
- `/return-to-voice` to move drafted players back to original draft voice channel and cleanup draft resources
- `/build-version` to show the running build commit hash/version
- `/test-lobby-music` to join your voice channel and test draft lobby music
- `/test-tts message:<text>` to test voice text-to-speech in the current voice channel
- Both commands are server-only (not available in DMs)
- `/team-draft` updates are broadcast in the channel message for everyone; mock defaults to broadcast too
- Dynamic team size from current voice member count (must be even)
  - 8 players => 4v4
  - 10 players => 5v5
- Random captain assignment
- Snake draft pick flow via select menu
- Draft pick updates are announced in chat after each selection
- Draft completion requires pressing **Start** (green button) to create channels/move players, or **Cancel** (red button) to abort
- Private temporary voice channels per team using temporary roles
- Automatic cleanup when team channels empty
- Optional daily CS2 notification message at configurable CST/CDT time (default 6:00 PM) with Interested / Not Interested / Subscribe / Unsubscribe buttons
- Optional draft lobby music from `/app/data/lobby.mp3` plus voice TTS pick announcements during drafts
  - Clicking Interested also auto-adds the notification role if missing

## Requirements

- Node.js 20+
- Discord bot with these permissions:
  - Manage Roles
  - Manage Channels
  - Move Members
  - Connect / View Channels
- Discord intent requirement:
  - Enable **Server Members Intent** in Discord Developer Portal for this bot

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
- `SQLITE_PATH` (optional, default `/app/data/bot.db`; persisted notification-state SQLite database file)
- `BUILD_VERSION` (optional, default `dev`; set automatically in Docker CI to commit SHA)
- `BUILD_DATE` (optional, default `unknown`; set automatically in Docker CI to commit date)
- `LOBBY_MUSIC_PATH` (optional, default `/app/data/lobby.mp3`; MP3 file for draft lobby music)

Notification scheduler is restart-safe: on startup, if today's daily message already exists, the bot reuses it and schedules the next run instead of reposting immediately.
When the daily message rolls over, previous-day message metadata and interested rows are removed from SQLite (no unbounded growth).

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

SQLite file location in container: `/app/data/bot.db` (or your custom `SQLITE_PATH`).

Draft lobby music file location in container: `/app/data/lobby.mp3` (or your custom `LOBBY_MUSIC_PATH`). If the file is missing, the bot still joins voice and uses TTS pick announcements without music.

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

## Troubleshooting

- If you see `Error: Used disallowed intents`, enable **Server Members Intent** in your bot settings in the Discord Developer Portal.
- If `/team-draft` says it must be used in a server, re-invite/update the bot commands and run it in a guild text channel (not a DM/app home).
- If mock voice says it is not in server context, the command is being executed outside a guild context (or stale command registration). Re-register commands and run from a server text channel.
- If new/updated commands do not appear, set `DISCORD_GUILD_ID` and restart bot; global command updates can take up to ~1 hour to propagate.
- If commands appear twice, you likely have both global and guild registrations. Keep `DISCORD_GUILD_ID` set and leave `KEEP_GLOBAL_COMMANDS` unset/`false` so startup clears globals.
