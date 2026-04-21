# CS2 Team Draft Discord Bot

A Discord bot that runs a random-captain snake draft from a voice channel, creates private temporary team voice channels, moves players automatically, and cleans up channels/roles when everyone leaves.

## Features

- `/team-draft` slash command
- `/team-draft-mock players:<even number> [spawn_voice:true|false]` for solo testing with fake users
- Dynamic team size from current voice member count (must be even)
  - 8 players => 4v4
  - 10 players => 5v5
- Random captain assignment
- Snake draft pick flow via select menu
- Private temporary voice channels per team using temporary roles
- Automatic cleanup when team channels empty

## Requirements

- Node.js 20+
- Discord bot with these permissions:
  - Manage Roles
  - Manage Channels
  - Move Members
  - Connect / View Channels
- Discord intents enabled in bot settings:
  - No privileged intents are required for the default setup.

## Environment Variables

Copy `.env.example` to `.env`:

- `DISCORD_TOKEN` (required)
- `DISCORD_GUILD_ID` (optional, recommended for fast slash command registration)
- `TEAM_CATEGORY_ID` (optional category ID for team channels)
- `MIN_PLAYERS` (optional, default `4`)

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
