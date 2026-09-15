'use strict';

const TAG = '[streambot]';

function redactToken(str, token) {
  if (typeof str !== 'string') return String(str == null ? '' : str);
  if (!token) return str;
  return str.split(token).join('***');
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

function loadConfig() {
  const token = (process.env.SELF_BOT_TOKEN || '').trim();
  if (!token) {
    throw new Error(
      `${TAG} missing required env SELF_BOT_TOKEN. ` +
        `Set it to a Discord user token to run the selfbot (never printed, not written to disk).`
    );
  }

  return {
    token,
    guildId: (process.env.SBOT_GUILD_ID || '').trim() || null,
    commandPrefix: (process.env.SBOT_COMMAND_PREFIX || '$').trim() || '$',
    streamChannelId: (process.env.STREAM_CHANNEL_ID || '').trim() || null,
    streamWidth: parsePositiveInt(process.env.STREAM_WIDTH, 1920),
    streamHeight: parsePositiveInt(process.env.STREAM_HEIGHT, 1080),
    streamFrameRate: parsePositiveNumber(process.env.STREAM_FRAME_RATE, 30),
    streamBitrate: parseKbps(process.env.STREAM_BITRATE, 5000),
    videoCodec: (process.env.VIDEO_CODEC || 'H264').trim() || 'H264',
    // 0 = disabled (no size guard); otherwise the max downloaded file size in MB.
    maxStreamSizeMb: parseNonNegativeInt(process.env.STREAMBOT_MAX_STREAM_SIZE_MB, 0),
    // Watchdog: max ms to wait for the go-live gateway handshake (STREAM_CREATE
    // + STREAM_SERVER_UPDATE) before tearing down. Selfbot tokens with
    // restricted gateway opcodes hang here forever; the library has no timeout.
    playStreamStartTimeoutMs: parsePositiveInt(process.env.STREAMBOT_PLAY_STREAM_TIMEOUT_MS, 30000),
    hardwareAccel: process.env.HARDWARE_ACCEL?.trim().toLowerCase() === 'true',
    ffmpegPath: (process.env.FFMPEG_PATH || '').trim() || 'ffmpeg',

    shareTvBase: normalizeBase(process.env.SHARETV_BASE),
    shareTvAllowHosts: parseHostList(process.env.SHARETV_ALLOW_HOSTS),
    ytdlpPath: (process.env.YTDLP_PATH || 'yt-dlp').trim() || 'yt-dlp',
    // Probe format (yt-dlp -g): used only to detect how many streams a source
    // produces. Single URL = combined; multiple = DASH (needs download+merge).
    ytdlpFormat: (process.env.YTDLP_FORMAT || 'bv*+ba/b').trim() || 'bv*+ba/b',
    ytdlpTimeoutMs: parsePositiveInt(process.env.YTDLP_TIMEOUT_MS, 20000),
    // DASH download+merge: best video+audio under 720p, else best. Capped at
    // 720p so a full 1080p VOD isn't pulled needlessly; raise if desired.
    ytdlpDownloadFormat: (process.env.YTDLP_DOWNLOAD_FORMAT || 'bv*[height<=720]+ba/b[height<=720]/b').trim() || 'bv*[height<=720]+ba/b[height<=720]/b',
    ytdlpDownloadTimeoutMs: parsePositiveInt(process.env.YTDLP_DOWNLOAD_TIMEOUT_MS, 300000),

    webhookSecret: (process.env.WEBHOOK_SECRET || '').trim(),
    // default 8081 avoids a same-host collision with iptv-share (which runs on 8080 in its own container)
    webhookPort: parsePositiveInt(process.env.STREAMBOT_WEBHOOK_PORT, 8081),
    // default 0.0.0.0 so a separate iptv-share container can reach it across the cluster; on a single host prefer 127.0.0.1
    webhookHost: (process.env.STREAMBOT_WEBHOOK_HOST || '0.0.0.0').trim() || '0.0.0.0'
  };
}

module.exports = { loadConfig, redactToken, TAG };
