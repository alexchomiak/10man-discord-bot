'use strict';

const M = Object.freeze({
  PONG: 'pong',
  JOIN_OK: (guildId) => `Joined voice in guild ${guildId}.`,
  JOIN_FAILED: 'Voice join failed.',
  JOIN_NEED_CHANNEL: 'Usage: `$join <voiceChannelId>` — pass a voice channel id to join.',
  JOIN_NO_GUILD: 'Could not resolve a guild; pass a channel id in a guild channel or set SBOT_GUILD_ID.',
  NO_TOKEN: 'Missing required env SELF_BOT_TOKEN.',
  NOT_AUTHORIZED: 'This message was not understood or the channel could not be resolved.',

  STREAM_USAGE: 'Usage: `stream <url>` · `stream stop` · `stream status` · `skip` · `scrub +10m` · `pause` · `resume` · `catchup`',
  STREAM_NEED_CHANNEL: 'Join a voice channel first, or set STREAM_CHANNEL_ID.',
  STREAM_BAD_URL: 'Please provide a valid http(s) stream URL.',
  STREAM_NO_CHANNEL: 'Could not resolve the target voice channel.',
  STREAM_JOIN_FAILED: 'Failed to join the voice channel.',
  STREAM_JOIN_TIMEOUT: 'Voice join timed out (gateway gave no voice events). The bot may have a stale voice session or the account\'s voice access may be restricted. Try $stop, wait 30s, then $stream again.',
  STREAM_START_FAILED: 'Failed to start the stream. Check the URL and ffmpeg (libzmq) availability.',
  STREAM_QUEUED: (label) => `Queued: ${label} (plays after the current content)`,
  STREAM_STARTED: (url) => `Now streaming: ${url}`,
  STREAM_VOD_ENDED: (title) => (title ? `Video finished: ${title}` : 'Video finished (VOD ended).'),
  STREAM_VOD_STOPPED: 'Stream stopped.',
  STREAM_STOPPED: 'Stopped.',
  STREAM_NOTHING: 'Nothing is currently streaming.',
  SKIP_NEXT: (label) => `Skipping → ${label}`,
  SKIP_NONE: 'Nothing to skip — no content playing or queued.',
  SKIP_FILLER: 'Queue empty — back to filler content.',

  // Playback controls (scrub / pause / resume / catchup). No channel sends —
  // these go to the local log + alert webhook only (like SKIP_*).
  SCRUB_USAGE: 'Usage: `scrub <signed>` — e.g. `scrub +10m`, `scrub -90s`, `scrub +1h30m`, `scrub +120` (VOD/seekable content only).',
  SCRUB_NEED_CONTENT: 'Nothing seekable is playing — start a VOD with `stream <url>` before scrubbing.',
  SCRUB_LIVE: 'Live streams can\'t be scrubbed — use `catchup` to jump back to the live head.',
  SCRUB_APPLIED: (sec) => `Scrubbed to +${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`,
  PAUSED: 'Paused (best-effort freeze — the stream is held open). Send `resume` to continue.',
  PAUSE_NEED_CONTENT: 'Nothing is playing to pause — start content with `stream <url>` first.',
  RESUMED: 'Resumed — feeding the stream again.',
  RESUME_NEED_CONTENT: 'Nothing is paused to resume.',
  CAUGHTUP: 'Caught up to the live head.',
  CATCHUP_NOT_LIVE: 'That content is not a live stream — nothing to catch up on.',
  CATCHUP_NEED_CONTENT: 'Nothing is playing to catch up on — start content with `stream <url>` first.',
  STREAM_STATUS: (s) =>
    [`Streaming: ${s.streamUrl}`, `Channel: ${s.channelId}`, `Started: ${Math.round(s.elapsedMs / 1000)}s ago`, s.alive ? 'Status: alive' : 'Status: ended'].join('\n'),
  STREAM_PLAY_STREAM_HANG: 'Stream did not start (selfbot token may not have gateway STREAM_CREATE permission). Run with VERBOSE=true and SBOT_DEBUG=1 for gateway event logs.',
  JOINED: (channelId) => `In the room (voice ${channelId}). Start a stream anytime — viewers are already set.`,
  // $join with the local filler PLACEHOLDER active (fillerOnJoin). The
  // go-live handshake is already pre-warmed; `stream <url>` swaps the real
  // feed in over the SAME live connection (no re-join, no missed seconds).
  JOINED_FILLER: (channelId) => `In the room (voice ${channelId}) and warming up the stream (placeholder). Send \`stream <url>\` to go live — the placeholder will be replaced.`,
  CHAINED: (label) => `Chaining → ${label} (same voice connection, no re-join)`,
  STREAM_GRACE_LEFT: 'Grace period over — leaving the voice channel. `stream <url>` to start another.',
  STREAM_NO_PROGRESSIVE: 'That source has no progressive (streamable) video+audio to play — it would require a full file download, which this bot never does.',

  SHARETV_BASE_UNSET: 'This looks like an IPTV-Share link, but SHARETV_BASE is not configured. Set SHARETV_BASE to your iptv-share base URL (e.g. http://host.docker.internal:8080 from inside Docker on Mac/Win, or the host IP in a Linux cluster). The bot cannot reach the host\'s localhost — inside a container, use host.docker.internal or a routable address.',
  SHARETV_NOT_FOUND: 'Could not find that ShareTV share (404 from the ShareTV API).',
  SHARETV_OFFLINE: 'Could not read that ShareTV share — the base looks wrong or is offline.',
  SHARETV_BASE_UNREACHABLE: 'Could not reach the ShareTV server — SHARETV_BASE is not routable from the bot (e.g. http://localhost still points at the bot container when it runs in Docker). Use a host-reachable base like http://host.docker.internal:8080.',
  SHARETV_LOCKED: 'Share is password-locked (use an unlocked share or the bot endpoint).',
  SHARETV_NO_EVENT: 'No streamable event for this share right now.',
  YTDLP_BINARY_MISSING: 'yt-dlp is not installed (set YTDLP_PATH to its binary path).',
  YTDLP_RESOLVE_FAILED: (detail) => `yt-dlp could not resolve that URL${detail ? ` — ${detail}` : ''}.`,
  SOURCE_UNRECOGNIZED: 'Not recognized as a ShareTV slug, direct media URL, or a yt-dlp-capable URL.',
  SOURCE_PASSTHROUGH: (kind, label) => `▶ ${kind} → ${label}`
});

module.exports = { M };
