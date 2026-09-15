'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { M } = require('./messages');
const { TAG } = require('./config');

const SHARETV_FETCH_TIMEOUT_MS = 10000;

function log(...parts) {
  console.log(TAG, ...parts);
}

function stripTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function extractSlug(path) {
  const p = String(path || '').trim();
  if (!p) return null;
  const withSlash = p.startsWith('/') ? p : `/${p}`;
  const s = withSlash.match(/\/s\/([A-Za-z0-9_-]+)\/?$/);
  if (s) return s[1];
  const segs = withSlash.split('/').filter(Boolean);
  const last = segs[segs.length - 1];
  if (last && /^[A-Za-z0-9_-]+$/.test(last)) return last;
  return null;
}

function detectShareSlug(raw, cfg) {
  const base = stripTrailingSlash(cfg.shareTvBase);
  const allowHosts = Array.isArray(cfg.shareTvAllowHosts) ? cfg.shareTvAllowHosts : [];
  if (/^https?:\/\//i.test(raw)) {
    const host = hostOf(raw);
    if (host) {
      if (allowHosts.includes(host)) return extractSlug(raw);
      if (base && raw.startsWith(`${base}/`)) return extractSlug(raw.slice(base.length));
    }
    return null;
  }
  if (!base) return null;
  return extractSlug(raw);
}

async function fetchShareApi(baseUrl, slug) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHARETV_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/api/public/share/${encodeURIComponent(slug)}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal
    });
    if (res.status === 404) return { status: 404, body: null };
    if (!res.ok) return { status: res.status, body: null };
    const body = await res.json().catch(() => null);
    return { status: res.status, body: typeof body === 'object' && body !== null ? body : null };
  } catch {
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
  }
}

// Platform-page hosts (mirrors iptv-share's PLATFORM_PAGE_HOSTS). A URL on one
// of these is a page, not a media endpoint: it must go through yt-dlp.
const PLATFORM_PAGE_HOSTS = [
  'twitch.tv', 'youtube.com', 'youtu.be',
  'vimeo.com', 'facebook.com', 'fb.watch',
  'instagram.com', 'tiktok.com', 'tmuxapp.com'
];

// True for anything that has the shape of an IPTV-Share /s/<slug> link or a
// bare slug. Such inputs are NEVER yt-dlp-page candidates: a share page is not
// playable media, so handing it to yt-dlp only produces a misleading
// "could not resolve that URL" error.
function looksLikeShareTv(raw) {
  if (typeof raw !== 'string') return false;
  const s = raw.trim();
  if (/^[A-Za-z0-9_-]+$/.test(s)) return true;
  if (/^https?:\/\//i.test(s)) {
    let p;
    try { p = new URL(s).pathname; } catch { return false; }
    return /^\/s\/[A-Za-z0-9_-]+([/?#]|$)/.test(p);
  }
  return false;
}

function isPlatformPage(raw) {
  let host;
  try {
    host = new URL(String(raw)).hostname.toLowerCase();
  } catch {
    return false;
  }
  return PLATFORM_PAGE_HOSTS.some((h) => host === h || host.endsWith('.' + h));
}

async function resolveShareTv(raw, cfg) {
  const base = stripTrailingSlash(cfg.shareTvBase);
  const slug = detectShareSlug(raw, cfg);
  if (!slug || !base) return null;

  log(`resolving ShareTV slug "${slug}" against ${base}`);
  const { status, body } = await fetchShareApi(base, slug);
  const share = body && body.share && typeof body.share === 'object' ? body.share : null;

  if (status === 404) return { kind: 'sharetv', available: false, note: M.SHARETV_NOT_FOUND };
  if (!share) return { kind: 'sharetv', available: false, note: M.SHARETV_OFFLINE };
  if (share.locked === true) return { kind: 'sharetv', available: false, note: M.SHARETV_LOCKED };

  // Priority: media_url > hls_url > stream_url.
  // For "platform" shares iptv-share publishes the ORIGINAL platform page URL
  // as media_url (e.g. https://twitch.tv/example) — NOT a proxied or resolved
  // URL. The bot owns yt-dlp resolution, so media_url flows through
  // resolveDirect (no match) and lands on resolveYtdlp below.
  // Ordinary HLS/MPEG-TS/native shares have no media_url; hls_url/stream_url
  // behavior is unchanged.
  const rel = share.media_url || share.hls_url || share.stream_url;
  if (share.stream_available === false || !rel) {
    return { kind: 'sharetv', available: false, note: M.SHARETV_NO_EVENT };
  }

  let streamUrl;
  try {
    streamUrl = new URL(rel, base).toString();
  } catch {
    if (/^https?:\/\//i.test(String(rel))) streamUrl = String(rel);
    else return { kind: 'sharetv', available: false, note: M.SHARETV_NO_EVENT };
  }

  const title = typeof share.title === 'string' ? share.title : null;
  const channel = typeof share.channel_name === 'string' ? share.channel_name : null;

  // Platform share: media_url is the ORIGINAL platform page URL (e.g.
  // https://twitch.tv/example). Not playable by ffmpeg, and the bot owns
  // yt-dlp resolution, so resolve it here before returning. Ordinary
  // HLS/MPEG-TS/native shares have no media_url and never enter this branch.
  const isPlatform =
    share.media_kind === 'platform' ||
    (share.media_kind == null && isPlatformPage(streamUrl));
  if (isPlatform) {
    const ytdlp = await resolveYtdlp(streamUrl, cfg);
    if (ytdlp.available && ytdlp.streamUrl) {
      return {
        kind: 'sharetv',
        streamUrl: ytdlp.streamUrl,
        localFile: !!ytdlp.localFile,
        localDir: ytdlp.localDir || null,
        title,
        channel,
        available: true,
        note: ytdlp.note || (ytdlp.localFile ? 'platform VOD downloaded + merged' : 'platform share resolved via yt-dlp')
      };
    }
    return {
      kind: 'sharetv',
      available: false,
      note: (ytdlp && ytdlp.note) || M.YTDLP_RESOLVE_FAILED()
    };
  }

  return {
    kind: 'sharetv',
    streamUrl,
    title,
    channel,
    available: true
  };
}

function resolveDirect(raw) {
  if (!/^https?:\/\//i.test(raw)) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const mediaExt = /\.(m3u8|m3u|mp4|mkv|ts)$/i.test(url.pathname);
  // Signed stream URL: recognize the known credential pairs. iptv-share uses
  // viewer/vsig; older builds used u/sig. Treat as opaque + direct (play with
  // ffmpeg, never through yt-dlp) if it carries a signing token.
  const signed =
    url.searchParams.has('sig') ||
    url.searchParams.has('vsig') ||
    (url.searchParams.has('u') && url.searchParams.has('sig'));
  if (!mediaExt && !signed) return null;
  return { kind: 'direct', streamUrl: raw, title: null, channel: null, available: true };
}

function lastNonEmptyLine(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
}

function urlLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\//.test(l));
}

function spawnYtdlp(cfg, args, timeoutMs) {
  const bin = String(cfg.ytdlpPath || 'yt-dlp').trim() || 'yt-dlp';
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ ok: false, code: -1, stdout: '', stderr: (err && err.message) || 'spawn failed', spawnErr: err });
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      if (proc.exitCode === null) {
        timedOut = true;
        try { proc.kill('SIGKILL'); } catch { }
      }
    }, timeoutMs);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    let spawnErr = null;
    proc.on('error', (err) => { spawnErr = err; });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (spawnErr) return resolve({ ok: false, code: code == null ? -1 : code, stdout, stderr, spawnErr, timedOut });
      resolve({ ok: code === 0, code, stdout, stderr, timedOut });
    });
  });
}

// Probe: yt-dlp -g returns the playable URL(s). Exactly one URL = a single
// combined stream (live / combined A+V) -> stream it directly. More than one
// URL = DASH (separate best-video + best-audio, e.g. YouTube VODs) -> must be
// downloaded + merged to a single file, then streamed by path.
async function ytdlpProbe(cfg, url) {
  const format = String(cfg.ytdlpFormat || 'bv*+ba/b').trim() || 'bv*+ba/b';
  const timeoutMs = Number.isFinite(cfg.ytdlpTimeoutMs) && cfg.ytdlpTimeoutMs > 0 ? cfg.ytdlpTimeoutMs : 20000;
  return spawnYtdlp(cfg, ['-g', '--no-playlist', '--format', format, url], timeoutMs);
}

// Download + merge DASH to a single local media file. Returns { ok, path, dir }.
async function ytdlpDownload(cfg, url) {
  const bin = String(cfg.ytdlpPath || 'yt-dlp').trim() || 'yt-dlp';
  const format = String(cfg.ytdlpDownloadFormat || 'bv*[height<=720]+ba/b[height<=720]/b').trim();
  const timeoutMs = Number.isFinite(cfg.ytdlpDownloadTimeoutMs) && cfg.ytdlpDownloadTimeoutMs > 0 ? cfg.ytdlpDownloadTimeoutMs : 300000;

  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streambot-ytdlp-'));
  } catch {
    return { ok: false, note: 'could not create a temp dir for the download' };
  }
  const outTemplate = path.join(dir, 'video'); // yt-dlp appends the container extension

  log(`downloading (DASH) to ${dir} via ${bin}`);
  const res = await spawnYtdlp(
    cfg,
    ['--no-playlist', '-o', outTemplate, '--format', format, url],
    timeoutMs
  );

  if (res.spawnErr) {
    rmDir(dir);
    if (res.spawnErr.code === 'ENOENT') return { ok: false, note: M.YTDLP_BINARY_MISSING };
    return { ok: false, note: (res.spawnErr.message) || 'yt-dlp spawn failed' };
  }
  if (res.timedOut) {
    rmDir(dir);
    return { ok: false, note: M.YTDLP_RESOLVE_FAILED(`timed out after ${timeoutMs}ms downloading`) };
  }
  if (!res.ok) {
    rmDir(dir);
    const detail = lastNonEmptyLine(res.stderr) || `exit code ${res.code}`;
    return { ok: false, note: M.YTDLP_RESOLVE_FAILED(detail) };
  }

  let file = null;
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((n) => n !== 'video.ytdl');
  } catch {
    entries = [];
  }
  // Prefer the merged output (e.g. video.mp4.webm); otherwise any non-partial file.
  const candidate =
    entries.find((n) => n.startsWith('video.') && !n.endsWith('.ytdl')) ||
    entries.find((n) => !n.endsWith('.ytdl'));
  if (candidate) file = path.join(dir, candidate);

  if (!file || !fs.existsSync(file)) {
    rmDir(dir);
    return { ok: false, note: 'yt-dlp exited 0 but produced no media file' };
  }

  const sizeBytes = fs.statSync(file).size;
  log(`download complete: ${sizeBytes} bytes -> ${file}`);

  const maxMb = Number.isFinite(cfg.maxStreamSizeMb) ? cfg.maxStreamSizeMb : 0;
  if (maxMb > 0 && sizeBytes > maxMb * 1024 * 1024) {
    rmDir(dir);
    return { ok: false, note: M.STREAM_TOO_LARGE(maxMb) };
  }

  return { ok: true, path: file, dir };
}

function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
}

async function resolveYtdlp(raw, cfg) {
  log(`resolving via yt-dlp`);
  const probe = await ytdlpProbe(cfg, raw);

  if (probe.spawnErr) {
    if (probe.spawnErr.code === 'ENOENT') return { kind: 'ytdlp', available: false, note: M.YTDLP_BINARY_MISSING };
    return { kind: 'ytdlp', available: false, note: M.YTDLP_RESOLVE_FAILED(probe.spawnErr.message) };
  }
  if (probe.timedOut) {
    return { kind: 'ytdlp', available: false, note: M.YTDLP_RESOLVE_FAILED(`timed out after ${cfg.ytdlpTimeoutMs || 20000}ms`) };
  }
  if (!probe.ok) {
    const detail = lastNonEmptyLine(probe.stderr) || `exit code ${probe.code}`;
    return { kind: 'ytdlp', available: false, note: M.YTDLP_RESOLVE_FAILED(detail) };
  }

  const urls = urlLines(probe.stdout);
  if (urls.length === 1) {
    // Single combined stream (live / A+V) -> stream the URL directly.
    const streamUrl = urls[0];
    return { kind: 'ytdlp', streamUrl, title: null, channel: null, available: true, localFile: false, localDir: null };
  }
  if (urls.length > 1) {
    // DASH: separate video + audio. Download + merge to a local file, then
    // stream by local path (matches the reference implementation).
    const dl = await ytdlpDownload(cfg, raw);
    if (dl.ok) {
      return {
        kind: 'ytdlp',
        streamUrl: dl.path,
        localFile: true,
        localDir: dl.dir,
        title: null,
        channel: null,
        available: true,
        note: 'DASH source downloaded + merged to a local file'
      };
    }
    return { kind: 'ytdlp', available: false, note: dl.note || M.YTDLP_RESOLVE_FAILED() };
  }

  return { kind: 'ytdlp', available: false, note: M.YTDLP_RESOLVE_FAILED('yt-dlp returned no URL') };
}

async function resolveSource(input, config) {
  const cfg = config || {};
  const raw = String(input || '').trim();
  if (!raw) return { kind: 'unknown', available: false, note: M.SOURCE_UNRECOGNIZED };

  const sharetv = await resolveShareTv(raw, cfg);
  if (sharetv) return sharetv;

  // Guard: /s/<slug> links (and bare slugs) are share pages, never playable
  // media for yt-dlp. Reaching here means the slug could not be detected
  // (SHARETV_BASE unset, or host mismatch) — bail with a helpful note instead
  // of a misleading "yt-dlp could not resolve that URL".
  if (looksLikeShareTv(raw)) {
    return { kind: 'sharetv', available: false, note: M.SHARETV_BASE_UNSET };
  }

  const direct = resolveDirect(raw);
  if (direct) return direct;

  const isHttp = /^https?:\/\//i.test(raw);
  const isPrefixed = /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s]+$/.test(raw);
  if (isHttp || isPrefixed) return resolveYtdlp(raw, cfg);

  return { kind: 'unknown', available: false, note: M.SOURCE_UNRECOGNIZED };
}

module.exports = {
  resolveSource,
  // Exposed for tests / advanced consumers:
  resolveShareTv,
  resolveDirect,
  resolveYtdlp,
  looksLikeShareTv,
  // primitives (used by tests and advanced consumers):
  spawnYtdlp,
  ytdlpProbe,
  ytdlpDownload,
  rmDir
};
