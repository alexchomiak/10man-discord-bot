'use strict';

const TAG = '[streambot]';

function redactToken(str, token) {
  if (typeof str !== 'string') return String(str == null ? '' : str);
  for (const secret of [token, process.env.PIA_PASSWORD]) {
    if (secret) str = str.split(secret).join('***');
  }
  return str;
}

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseNonNegativeInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parsePositiveNumber(value, fallback) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseNonNegativeNumber(value, fallback) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function parseKbps(value, fallbackKbps) {
  if (typeof value !== 'string') return fallbackKbps;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(k|kb|kbit|kbps|m|mb|mbit|mbps)?$/i);
  if (!match) return fallbackKbps;
  const num = Number.parseFloat(match[1]);
  if (!Number.isFinite(num) || num <= 0) return fallbackKbps;
  const unit = (match[2] || '').toLowerCase();
  if (unit.startsWith('m')) return num * 1000;
  return num;
}

function normalizeBase(value) {
  const s = (value || '').trim();
  if (!s) return null;
  return s.replace(/\/+$/, '');
}

function parseHostList(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
}

function parseLangList(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
}

function loadConfig() {
  const token = (process.env.SELF_BOT_TOKEN || '').trim();
  if (!token) {
    throw new Error(
      `${TAG} missing required env SELF_BOT_TOKEN. ` +
        `Set it to a Discord user token to run the selfbot (never printed, not written to disk).`
    );
  }

  const hardwareAccel = process.env.HARDWARE_ACCEL?.trim().toLowerCase() === 'true';
  const configuredEncoder = (process.env.STREAMBOT_VIDEO_ENCODER || '').trim().toLowerCase();

  return {
    token,
    guildId: (process.env.SBOT_GUILD_ID || '').trim() || null,
    commandPrefix: (process.env.SBOT_COMMAND_PREFIX || '$').trim() || '$',
    streamChannelId: (process.env.STREAM_CHANNEL_ID || '').trim() || null,
    streamWidth: parsePositiveInt(process.env.STREAM_WIDTH, 1920),
    streamHeight: parsePositiveInt(process.env.STREAM_HEIGHT, 1080),
    streamFrameRate: parsePositiveNumber(process.env.STREAM_FRAME_RATE, 30),
    streamBitrate: parseKbps(process.env.STREAM_BITRATE, 5000),
    // Keep the source at or below the output raster. Pulling a 1440p/4K track
    // only to downscale it to 1080p wastes decoder bandwidth and GPU/CPU.
    sourceMaxHeight: parsePositiveInt(process.env.SBOT_SOURCE_MAX_HEIGHT, 1080),
    // Audio bitrate used when merging separate video+audio (DASH) streams in-memory.
    streamAudioBitrate: parseKbps(process.env.STREAMBOT_AUDIO_BITRATE, 128),
    videoCodec: (process.env.VIDEO_CODEC || 'H264').trim() || 'H264',
    // Watchdog: max ms to wait for the go-live gateway handshake (STREAM_CREATE
    // + STREAM_SERVER_UPDATE) before tearing down. Selfbot tokens with
    // restricted gateway opcodes hang here forever; the library has no timeout.
    playStreamStartTimeoutMs: parsePositiveInt(process.env.STREAMBOT_PLAY_STREAM_TIMEOUT_MS, 30000),
    // Watchdog for the VOICE join itself (Streamer.joinVoice): that promise
    // only settles on VOICE_STATE_UPDATE + VOICE_SERVER_UPDATE gateway
    // events, which a restricted selfbot token may never receive — no
    // timeout in the library, and a hung join wedges the serialize lock so
    // every later $stream queues behind it forever.
    joinVoiceTimeoutMs: parsePositiveInt(process.env.SBOT_JOIN_VOICE_TIMEOUT_MS, 20000),
    // Grace period after any stream ends: the bot STAYS in the voice channel
    // this long so viewers can chain the next stream without re-joining.
    // A new stream within the window cancels the leave; an explicit $stop
    // always leaves immediately (no grace).
    streamQueueLimit: parsePositiveInt(process.env.STREAM_QUEUE_LIMIT, 20),
    streamGraceMs: parsePositiveInt(process.env.STREAM_GRACE_MS, 300000),
    // The library's "initial burst" disables BOTH A/V sync and wall-clock
    // sleeping, so a long value sends buffered frames as a packet burst. Keep
    // it disabled for smooth 30 fps pacing. The legacy env knobs remain for a
    // short operator-controlled startup experiment; AV_SYNC takes precedence.
    startBurstSec: parseNonNegativeNumber(process.env.SBOT_START_BURST_SEC, 0),
    avSyncBurstSec: parseNonNegativeNumber(process.env.SBOT_AV_SYNC_BURST_SEC, 0),
    // $join FILLER (placeholder + go-live handshake pre-warm). When enabled
    // (default), $join opens the channel AND starts a local "filler" playback
    // so (1) viewers see a clean placeholder instead of silence, and (2) the
    // go-live gateway handshake (STREAM_CREATE + STREAM_SERVER_UPDATE) is
    // pre-warmed on the voice WS — a later real `stream <url>` then swaps in
    // over the existing live connection with NO re-join and NO 10-15s gap.
    fillerOnJoin: (process.env.SBOT_FILLER_ON_JOIN != null ? String(process.env.SBOT_FILLER_ON_JOIN) : 'true').trim().toLowerCase() !== 'false',
    // Placeholder piece duration before abandonment/grace (seconds).
    // This never ends the persistent pipeline itself. 0 (= unset) derives a
    // generous default at runtime from the grace window:
    //   max(streamGraceMs / 1000 * 2, 300)   (with the 300000ms default grace
    //                                        → 600s, i.e. 10 minutes).
    // Set a positive integer to override explicitly.
    fillerDurationSec: parseNonNegativeInt(process.env.SBOT_FILLER_DURATION_SEC, 0),
    // Between-stream buffer (seconds): when a new real stream is queued while
    // another real stream is active or queued, a short filler is inserted
    // immediately before the new real piece so the transition is clean.
    // 0 (= unset) disables the buffer (streams play back-to-back).
    streamBufferSec: parseNonNegativeInt(process.env.SBOT_STREAM_BUFFER_SEC, 15),
    // Upper bound (seconds) for how long a $pause may be held. Default 900
    // (15 minutes); 0 = unlimited. $resume still works past the bound (it
    // rebuilds from the VOD held position or the LIVE head) — the bound is
    // best-effort so an abandoned pause is not treated as permanent. Reported
    // by status() as paused:true while held.
    maxPauseSec: parseNonNegativeInt(process.env.SBOT_MAX_PAUSE_SEC, 900),
    hardwareAccel,
    // Keep libx264 as the default encoder, including on GPU-equipped hosts.
    // VAAPI remains available only through an explicit encoder selection.
    videoEncoder: ['software', 'vaapi'].includes(configuredEncoder)
      ? configuredEncoder
      : 'software',
    // Hardware-frame decode needs a different filter graph from the stable
    // software-scale -> VAAPI-upload encode path. Leave it opt-in; Arc encode
    // already removes the expensive part of 1080p H.264 transcoding.
    hardwareDecode: process.env.STREAMBOT_HARDWARE_DECODE?.trim().toLowerCase() === 'true',
    vaapiDevice: (process.env.STREAMBOT_VAAPI_DEVICE || '/dev/dri/renderD128').trim() || '/dev/dri/renderD128',
    // Bounded NUT queue between FFmpeg and Discord. Eight MiB is roughly
    // 11-13 seconds at the default aggregate bitrate, enough to absorb short
    // CDN/VPN stalls without allowing unbounded memory growth.
    pipelineBufferMb: parsePositiveInt(process.env.SBOT_PIPELINE_BUFFER_MB, 8),
    ffmpegReadTimeoutMs: parsePositiveInt(process.env.SBOT_FFMPEG_READ_TIMEOUT_MS, 15000),
    ffmpegPath: (process.env.FFMPEG_PATH || '').trim() || 'ffmpeg',

    shareTvBase: normalizeBase(process.env.SHARETV_BASE),
    shareTvAllowHosts: parseHostList(process.env.SHARETV_ALLOW_HOSTS),
    ytdlpPath: (process.env.YTDLP_PATH || 'yt-dlp').trim() || 'yt-dlp',
    // Format selection hint for yt-dlp (--dump-json resolution). Kept for
    // backward-compat; resolution is progressive and never downloads.
    ytdlpFormat: (process.env.YTDLP_FORMAT || 'bv*+ba/b').trim() || 'bv*+ba/b',
    ytdlpTimeoutMs: parsePositiveInt(process.env.YTDLP_TIMEOUT_MS, 20000),
    // Preferred audio-language codes for YouTube/DASH multi-audio tracks,
    // comma-separated (e.g. "en,es"). Earlier = stronger preference. Default
    // "en" (English). An empty value ("") means "no preference" — in which
    // case the original/first-listed track is chosen. This ONLY affects the
    // AUDIO track pick; video-track ordering (vcodec/height) is untouched.
    audioLang: parseLangList(process.env.SBOT_AUDIO_LANG == null ? 'en' : process.env.SBOT_AUDIO_LANG),

    webhookSecret: (process.env.WEBHOOK_SECRET || '').trim(),
    // default 8081 avoids a same-host collision with iptv-share (which runs on 8080 in its own container)
    webhookPort: parsePositiveInt(process.env.STREAMBOT_WEBHOOK_PORT, 8081),
    // default 0.0.0.0 so a separate iptv-share container can reach it across the cluster; on a single host prefer 127.0.0.1
    webhookHost: (process.env.STREAMBOT_WEBHOOK_HOST || '0.0.0.0').trim() || '0.0.0.0',
    // Optional OUTBOUND alert webhook (see alerts.js): the bot account is
    // restricted and can no longer send channel messages, so success/error
    // feedback is logged locally and POSTed to a regular Discord server
    // webhook (any channel) when this is set. Errors + stream-state only.
    alertWebhookUrl: (process.env.TELEMETRY_WEBHOOK_URL || '').trim() || null
  };
}

module.exports = { loadConfig, redactToken, TAG };
