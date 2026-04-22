# CS2 Team Draft Discord Bot

A Discord bot that runs a random-captain snake draft from a voice channel, creates private temporary team voice channels, moves players automatically, and cleans up channels/roles when everyone leaves.

## Features

- `/team-draft` slash command
- `/team-draft players:<optional even number> captain1:<@user> captain2:<@user>` to set total drafted players and/or manually pick captains (captains must be in same voice channel)
- `/team-draft-mock players:<even number> [spawn_voice:true|false] [broadcast:true|false]` for solo testing with fake users
- `/draft-status` to inspect active draft/mock resources
- `/draft-cancel` to cancel active draft and cleanup resources
- `/draft-cleanup` to force cleanup resources if something gets stuck
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
- `MIN_PLAYERS` (optional, default `4`)

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
  --env-file /path/to/.env \
  cs2-team-draft-bot:latest
```

## GitHub Action: Build + Push to Docker Hub

A workflow is included at `.github/workflows/docker-publish.yml` and runs on pushes to `main`.

Set these GitHub repo secrets:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN` (Docker Hub access token)
- `DOCKERHUB_IMAGE_NAME` (optional, e.g. `yourname/10man-discord-bot`; defaults to `DOCKERHUB_USERNAME/10man-discord-bot`)

### Suggested Unraid container settings

- Repository: image you build/push
- Network type: bridge
- Restart policy: unless-stopped
- Variables:
  - `DISCORD_TOKEN`
  - `DISCORD_GUILD_ID` (optional)
  - `TEAM_CATEGORY_ID` (optional)
  - `MIN_PLAYERS` (optional)

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
