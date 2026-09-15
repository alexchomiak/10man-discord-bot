'use strict';

const M = Object.freeze({
  PONG: 'pong',
  JOIN_OK: (guildId) => `Joined voice in guild ${guildId}.`,
  JOIN_FAILED: 'Voice join failed.',
  JOIN_NEED_CHANNEL: 'Usage: `$join <voiceChannelId>` — pass a voice channel id to join.',
  JOIN_NO_GUILD: 'Could not resolve a guild; pass a channel id in a guild channel or set SBOT_GUILD_ID.',
  NO_TOKEN: 'Missing required env SELF_BOT_TOKEN.',
  NOT_AUTHORIZED: 'This message was not understood or the channel could not be resolved.',

  STREAM_USAGE: 'Usage: `stream <url>` · `stream stop` · `stream status`',
  STREAM_NEED_CHANNEL: 'Join a voice channel first, or set STREAM_CHANNEL_ID.',
  STREAM_BAD_URL: 'Please provide a valid http(s) stream URL.',
  STREAM_NO_CHANNEL: 'Could not resolve the target voice channel.',
  STREAM_JOIN_FAILED: 'Failed to join the voice channel.',
  STREAM_START_FAILED: 'Failed to start the stream. Check the URL and ffmpeg (libzmq) availability.',
  STREAM_STARTED: (url) => `Now streaming: ${url}`,
  STREAM_STOPPED: 'Stopped.',
  STREAM_NOTHING: 'Nothing is currently streaming.',
  STREAM_STATUS: (s) =>
    [`Streaming: ${s.streamUrl}`, `Channel: ${s.channelId}`, `Started: ${Math.round(s.elapsedMs / 1000)}s ago`, s.alive ? 'Status: alive' : 'Status: ended'].join('\n'),
  STREAM_PLAY_STREAM_HANG: 'Stream did not start (selfbot token may not have gateway STREAM_CREATE permission). Run with SBOT_DEBUG=1 for gateway event logs.',
  STREAM_TOO_LARGE: (mb) => 'Downloaded file exceeds the configured maximum size (STREAMBOT_MAX_STREAM_SIZE_MB=' + mb + '). Lower it or pick a smaller source.',

  SHARETV_NOT_FOUND: 'Could not find that ShareTV share (404 from the ShareTV API).',
  SHARETV_OFFLINE: 'Could not read that ShareTV share — the base looks wrong or is offline.',
  SHARETV_LOCKED: 'Share is password-locked (use an unlocked share or the bot endpoint).',
  SHARETV_NO_EVENT: 'No streamable event for this share right now.',
  YTDLP_BINARY_MISSING: 'yt-dlp is not installed (set YTDLP_PATH to its binary path).',
  YTDLP_RESOLVE_FAILED: (detail) => `yt-dlp could not resolve that URL${detail ? ` — ${detail}` : ''}.`,
  SOURCE_UNRECOGNIZED: 'Not recognized as a ShareTV slug, direct media URL, or a yt-dlp-capable URL.',
  SOURCE_PASSTHROUGH: (kind, label) => `▶ ${kind} → ${label}`
});

module.exports = { M };
