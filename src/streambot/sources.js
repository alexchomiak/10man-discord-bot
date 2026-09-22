'use strict';

const { spawn } = require('child_process');
const { M } = require('./messages');
const { TAG } = require('./config');

const SHARETV_FETCH_TIMEOUT_MS = 10000;

function log(...parts) {
  console.log(TAG, ...parts);
}

function verboseLog(config, ...parts) {
  if (config?.verbose === true) log(...parts);
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

  verboseLog(cfg, `resolving ShareTV slug "${slug}" against ${base}`);
  const { status, body } = await fetchShareApi(base, slug);
  const share = body && body.share && typeof body.share === 'object' ? body.share : null;

  if (status === 404) return { kind: 'sharetv', available: false, note: M.SHARETV_NOT_FOUND };
  if (status === 0) return { kind: 'sharetv', available: false, note: M.SHARETV_BASE_UNREACHABLE };
  if (!share) return { kind: 'sharetv', available: false, note: M.SHARETV_OFFLINE };
  if (share.locked === true) return { kind: 'sharetv', available: false, note: M.SHARETV_LOCKED };

  // Priority: media_url > stream_url > hls_url.
  // For "platform" shares iptv-share publishes the ORIGINAL platform page URL
  // as media_url (e.g. https://twitch.tv/example) — NOT a proxied or resolved
  // URL. The bot owns yt-dlp resolution, so media_url flows through
  // resolveDirect (no match) and lands on resolveYtdlp below.
  // Ordinary shares: prefer stream_url (continuous MPEG-TS) over hls_url.
  // The library detects HLS by an "m3u" substring in the URL (newApi.js:85);
  // our hls_url endpoints (/api/public/stream/<slug>?...&hls=1) fail that
  // test, so non-HLS reconnect flags get applied to an HLS playlist and
  // ffmpeg reconnect-loops on every segment EOF — Demuxer.open never
  // resolves and the go-live handshake never happens. The raw stream_url
  // is a continuous live stream the reconnect flags are designed for and
  // demuxes cleanly (verified in-container).
  const rel = share.media_url || share.stream_url || share.hls_url;
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

  // iptv-share pins generated stream URLs to ITS OWN server host
  // (e.g. http://localhost:8080/...). That host is only meaningful where
  // iptv-share runs — from the bot (often in Docker) it is a dead loopback.
  // Rewrite to the host of SHARETV_BASE, preserving path + query.
  const baseHost = hostOf(base);
  let rawStream;
  try {
    rawStream = new URL(streamUrl);
  } catch {
    rawStream = null;
  }
  // Platform shares carry the ORIGINAL platform page URL (e.g. twitch.tv) as
  // their media — that is expected and resolves via yt-dlp below, so never
  // treat it as a cross-host stream URL.
  if (rawStream && baseHost && rawStream.hostname.toLowerCase() !== baseHost && !isPlatformPage(streamUrl)) {
    if (rawStream.hostname === 'localhost' || /^127\./.test(rawStream.hostname) || rawStream.hostname === '::1' || rawStream.hostname === '[::1]') {
      streamUrl = new URL(rawStream.pathname + rawStream.search, base).toString();
    } else {
      verboseLog(cfg, `ignoring cross-host stream URL ${rawStream.hostname} (base is ${baseHost})`);
      return { kind: 'sharetv', available: false, note: M.SHARETV_OFFLINE };
    }
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
    if (ytdlp.available) {
      const out = {
        kind: 'sharetv',
        title,
        channel,
        available: true,
        startOffsetSec: ytdlp.startOffsetSec || null,
        // A platform share resolves to yt-dlp output: a VOD (seekable) unless
        // the platform itself is live, which yt-dlp would mark as live.
        isLive: ytdlp.isLive === true,
        totalDurationSec: ytdlp.totalDurationSec != null ? ytdlp.totalDurationSec : null,
        note: ytdlp.note || 'platform share resolved via yt-dlp'
      };
      if (ytdlp.streamType === 'dash') {
        out.streamType = 'dash';
        out.videoUrl = ytdlp.videoUrl;
        out.audioUrl = ytdlp.audioUrl;
      } else {
        out.streamType = 'single';
        out.streamUrl = ytdlp.streamUrl;
      }
      return out;
    }
    return {
      kind: 'sharetv',
      available: false,
      note: (ytdlp && ytdlp.note) || M.YTDLP_RESOLVE_FAILED()
    };
  }

  // Ordinary (non-platform) shares are continuous LIVE feeds (MPEG-TS/HLS):
  // not seekable → $scrub is N/A, $catchup (jump to live head) is the tool.
  return {
    kind: 'sharetv',
    streamUrl,
    title,
    channel,
    available: true,
    isLive: true,
    totalDurationSec: null
  };
}

function resolveDirect(raw, cfg) {
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
  // iptv-share pins signed stream URLs to ITS OWN server host
  // (e.g. http://localhost:8080/...). From the bot (often in Docker) that
  // host is a dead loopback and ffmpeg dies with ECONNREFUSED /
  // EADDRNOTAVAIL. When the URL is loopback-pinned and SHARETV_BASE points
  // elsewhere, rewrite to the base host (path + query preserved). Same rule
  // as resolveShareTv; a loopback base (bare-process deployment) is a no-op.
  const base = cfg && stripTrailingSlash(cfg.shareTvBase);
  let streamUrl = raw;
  if (base) {
    const baseHost = hostOf(base);
    const h = url.hostname.toLowerCase();
    if (
      baseHost &&
      (h === 'localhost' || h === '::1' || h === '[::1]' || /^127\./.test(h)) &&
      h !== baseHost.toLowerCase()
    ) {
      streamUrl = new URL(url.pathname + url.search + url.hash, base).toString();
    }
  }
  // A direct URL may be a continuous live feed (.m3u8/.ts, iptv-share hls=1)
  // or a seekable VOD file (.mp4/.mkv). isLive drives scrub-vs-catchup.
  const live = isLiveLikeUrl(streamUrl);
  return { kind: 'direct', streamUrl, title: null, channel: null, available: true, isLive: live, totalDurationSec: null };
}

function lastNonEmptyLine(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : null;
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

// True when a direct http(s) media URL is a CONTINUOUS live feed (HLS .m3u8
// playlist or MPEG-TS) rather than a seekable VOD file. Used to set a piece's
// isLive flag (live → $catchup, non-live/VOD → $scrub). Never throws.
function isLiveLikeUrl(raw) {
  try {
    const u = new URL(String(raw));
    const p = u.pathname.toLowerCase();
    if (/\.(m3u8|ts)$/.test(p)) return true;
    // ShareTV's signed MPEG-TS endpoint has no media-file extension.
    if (/^\/api\/public\/stream\/[a-z0-9_-]+\/?$/.test(p)) return true;
    // iptv-share HLS endpoints use a query flag rather than a .m3u8 extension.
    if (u.searchParams.has('hls')) return true;
    return false;
  } catch {
    return false;
  }
}

// Parse a YouTube-style start offset out of a URL query string. Returns a
// non-negative integer number of SECONDS, or null when absent/unparseable.
// Priority: t, then st, then start (vq is ignored). Never throws.
// Accepts `120` (seconds), `1h2m3s`, `2m30s`, `90s`, `30m`, etc.
function parseStartTime(raw) {
  try {
    let u;
    try {
      u = new URL(String(raw));
    } catch {
      return null;
    }
    let value = null;
    for (const key of ['t', 'st', 'start']) {
      const v = u.searchParams.get(key);
      if (v != null && v !== '') {
        value = v;
        break;
      }
    }
    if (value == null) return null;
    const s = String(value).trim();

    if (/^\d+$/.test(s)) {
      const n = Number.parseInt(s, 10);
      return Number.isFinite(n) && n >= 0 ? n : null;
    }

    // Compound duration: a sequence of <number><h|m|s> tokens, nothing else.
    const re = /\d+[hms]/gi;
    const parts = s.match(re);
    if (!parts || s.replace(re, '').trim() !== '') return null;
    let total = 0;
    for (const part of parts) {
      const num = Number.parseInt(part, 10);
      const unit = part.slice(-1).toLowerCase();
      if (!Number.isFinite(num)) return null;
      if (unit === 'h') total += num * 3600;
      else if (unit === 'm') total += num * 60;
      else total += num;
    }
    return total;
  } catch {
    return null;
  }
}

// Parse a SIGNED duration token into seconds, or null when invalid. Accepts a
// leading `+` or `-` sign (default `+`), then either a bare integer (seconds)
// or a compound `<n><h|m|s>` sequence. This is the mirror of parseStartTime
// with a sign, and is the shared parser for $scrub (+10m, -90s, +1h30m, +120).
function parseSignedDuration(raw) {
  try {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return null;
    let sign = 1;
    let body = s;
    if (/^[+-]/.test(s)) {
      sign = s[0] === '-' ? -1 : 1;
      body = s.slice(1);
    }
    if (!body) return null;
    if (/^\d+$/.test(body)) {
      const n = Number.parseInt(body, 10);
      return Number.isFinite(n) ? sign * n : null;
    }
    // Compound duration: a sequence of <number><h|m|s> tokens, nothing else.
    const re = /\d+[hms]/gi;
    const parts = body.match(re);
    if (!parts || body.replace(re, '').trim() !== '') return null;
    let total = 0;
    for (const part of parts) {
      const num = Number.parseInt(part, 10);
      const unit = part.slice(-1).toLowerCase();
      if (!Number.isFinite(num)) return null;
      if (unit === 'h') total += num * 3600;
      else if (unit === 'm') total += num * 60;
      else total += num;
    }
    return sign * total;
  } catch {
    return null;
  }
}

// --dump-json probe: returns the raw spawn result; parsing happens in
// resolveYtdlp so tests can stub stdout.
function ytdlpDumpJson(cfg, url) {
  const timeoutMs = Number.isFinite(cfg.ytdlpTimeoutMs) && cfg.ytdlpTimeoutMs > 0 ? cfg.ytdlpTimeoutMs : 20000;
  // The image already includes Node. Let current yt-dlp use it for YouTube's
  // player challenges so format discovery does not silently return a reduced
  // set with the "no supported JavaScript runtime" warning.
  return spawnYtdlp(cfg, ['--js-runtimes', 'node', '--dump-json', '--no-playlist', url], timeoutMs);
}

// vcodec preference: lower index = better; unknown vcodec codes sort last.
// yt-dlp sometimes reports fourcc-style codes (avc1.640028, hev1.1.6...) —
// normalize the common prefixes to canonical names for ranking purposes.
const VCODEC_PRIORITY = ['h264', 'h265', 'vp9', 'vp8', 'av1'];
const VCODEC_FOURCC_ALIAS = {
  avc1: 'h264', avc3: 'h264',
  hev1: 'h265', hvc1: 'h265',
  vp09: 'vp9', av01: 'av1'
};

function normalizeVcodec(value) {
  const v = String(value || '').toLowerCase();
  for (const [prefix, name] of Object.entries(VCODEC_FOURCC_ALIAS)) {
    if (v === prefix || v.startsWith(prefix + '.') || v.startsWith(prefix + '-')) return name;
  }
  return v;
}

function vcodecRank(format) {
  const idx = VCODEC_PRIORITY.indexOf(normalizeVcodec(format && format.vcodec));
  return idx === -1 ? VCODEC_PRIORITY.length : idx;
}

// Comparator: better candidate first (returns negative when a wins).
// vcodec priority, then higher height (null=0), then higher tbr.
function compareFormats(a, b) {
  const va = vcodecRank(a);
  const vb = vcodecRank(b);
  if (va !== vb) return va - vb;
  const ha = Number.isFinite(a.height) ? a.height : 0;
  const hb = Number.isFinite(b.height) ? b.height : 0;
  if (ha !== hb) return hb - ha;
  const ta = Number.isFinite(a.tbr) ? a.tbr : 0;
  const tb = Number.isFinite(b.tbr) ? b.tbr : 0;
  return tb - ta;
}

// Audio-language preference rank: lower = better. Orders
//   preferred (lowest, by position in preferredLangs)
//   -> unknown / original ('none' / '' / 'und' / absent)
//   -> known but non-preferred language, ordered by YouTube's own
//      language_preference (lower = more preferred), then alphabetically so
//      the tier is deterministic.
const LANG_UNKNOWN_RANK = 1000;
const LANG_NONPREFERRED_BASE_RANK = 2000;
function langPreferenceRank(format) {
  const raw = format && (format.language_preference ?? format.lang_preference);
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : Infinity;
}
// A language code matches a preference when it equals it, or starts with the
// preference followed by '-' (e.g. 'en-US' matches 'en'). Keeps the
// comparison simple and predictable; three-letter tags ('eng') match their
// two-letter primary subtag. Never throws.
function langMatchesPreference(p, lang) {
  if (!p) return false;
  const pLow = String(p).trim().toLowerCase();
  if (!pLow || !lang) return false;
  if (pLow === lang) return true;
  if (lang.startsWith(pLow + '-')) return true;
  const primaryOf = (s) => (s.length >= 3 ? s.slice(0, 2) : s);
  if (pLow.length === 2 && primaryOf(lang) === pLow) return true;
  return false;
}
function langRank(format, preferredLangs) {
  // The real yt-dlp format field is `language` (e.g. "en", "ar", "en-US");
  // `alang` is kept as a defensive fallback, but is absent from real dumps.
  const raw = (format && (format.language || format.alang)) || '';
  const lang = String(raw == null ? '' : raw).trim().toLowerCase();
  const prefs = Array.isArray(preferredLangs) ? preferredLangs : [];
  if (prefs.length > 0 && lang !== '') {
    for (let i = 0; i < prefs.length; i += 1) {
      const p = String(prefs[i] == null ? '' : prefs[i]).trim().toLowerCase();
      if (!p) continue;
      // Simple, predictable match (see langMatchesPreference): exact, 'en-US'
      // vs 'en', or a three-letter tag ('eng') against its 2-letter subtag.
      if (langMatchesPreference(p, lang)) return i;
    }
  }
  if (lang === '' || lang === 'none' || lang === 'und') return LANG_UNKNOWN_RANK;
  return LANG_NONPREFERRED_BASE_RANK;
}

// Comparator for COMBINED A+V formats (HLS/DASH manifests or direct files).
// Language preference first (so a preferred-language track beats a foreign
// dub even at higher bitrate); then, when NOTHING is preferred and both tracks
// land in the non-preferred tier, YouTube's own language_preference (lower =
// more preferred; -1/absent = unknown, sorted last); then vcodec/height/
// bitrate so video quality is still respected. Pure-video comparisons keep
// using compareFormats (language must not distort video-track ordering).
function compareAVFormats(a, b, preferredLangs) {
  const la = langRank(a, preferredLangs);
  const lb = langRank(b, preferredLangs);
  if (la !== lb) return la - lb;
  if (la >= LANG_NONPREFERRED_BASE_RANK) {
    // Unknown (-1/absent) sorts last; otherwise the lower preference wins.
    const pa = langPreferenceRank(a);
    const pb = langPreferenceRank(b);
    if (pa !== Infinity && pb !== Infinity && pa !== pb) return pa > pb ? 1 : -1;
    if (pa !== pb) {
      // One known, one unknown: the known (finite) preference wins.
      if (pa === Infinity) return 1;
      if (pb === Infinity) return -1;
    }
  }
  return compareFormats(a, b);
}

// Select the best audio track. Semantics (desired behavior):
//   1. Prefer a track whose language is in preferredLangs (earlier = stronger),
//      choosing the highest bitrate among preferred-language candidates.
//   2. Else, when nothing is preferred, prefer the track with the best
//      language_preference (lower = more preferred; -1/absent = last), then
//      the highest bitrate.
//   3. Final tie-break is always the highest bitrate (tbr).
// Returns the winning format object (or null when no candidates).
function pickBestAudio(candidates, preferredLangs) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const prefRank = (format) => {
    const r = langPreferenceRank(format);
    return r === Infinity ? 0 : r; // -1 / unknown sort LAST (>= real prefs incl. 0)
  };
  let best = null;
  let bestKey = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const cand = candidates[i];
    // key: [langRank(ascending), platform language_preference(ascending,
    // unknown last), -tbr(descending bitrate), original index] — all
    // compared ascending, so the FIRST minimum wins; tbr is the final key.
    const key = [
      langRank(cand, preferredLangs),
      prefRank(cand),
      -(Number.isFinite(cand.tbr) ? cand.tbr : 0),
      i
    ];
    if (!best) { best = cand; bestKey = key; continue; }
    let less = false;
    for (let k = 0; k < key.length; k += 1) {
      if (key[k] < bestKey[k]) { less = true; break; }
      if (key[k] > bestKey[k]) break;
    }
    if (less) { best = cand; bestKey = key; }
  }
  return best;
}

function isCombined(format) {
  return format && format.vcodec !== 'none' && format.acodec !== 'none';
}

async function resolveYtdlp(raw, cfg) {
  const config = cfg || {};
  verboseLog(config, 'resolving via yt-dlp');
  // Preferred audio-language codes (default English). loadConfig always hands
  // us an array; normalize defensively (string -> [string]) and fall back to
  // ['en'] when the key is absent (e.g. hand-built test configs).
  let preferredLangs = config.audioLang;
  if (typeof preferredLangs === 'string') preferredLangs = [preferredLangs];
  if (!Array.isArray(preferredLangs)) preferredLangs = ['en'];
  const res = await ytdlpDumpJson(cfg, raw);

  if (res.spawnErr) {
    if (res.spawnErr.code === 'ENOENT') return { kind: 'ytdlp', available: false, note: M.YTDLP_BINARY_MISSING };
    return { kind: 'ytdlp', available: false, note: M.YTDLP_RESOLVE_FAILED(res.spawnErr.message) };
  }
  if (res.timedOut) {
    return { kind: 'ytdlp', available: false, note: M.YTDLP_RESOLVE_FAILED(`timed out after ${cfg.ytdlpTimeoutMs || 20000}ms`) };
  }
  if (!res.ok) {
    const detail = lastNonEmptyLine(res.stderr);
    return { kind: 'ytdlp', available: false, note: M.YTDLP_RESOLVE_FAILED(detail) };
  }

  // --dump-json: first line is the entry JSON object. Fall back to scanning
  // subsequent lines for the first one that parses to an object.
  let data = null;
  const lines = String(res.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        data = parsed;
        break;
      }
    } catch {
      // keep scanning
    }
  }
  if (!data) {
    return { kind: 'ytdlp', available: false, note: M.YTDLP_RESOLVE_FAILED('could not parse yt-dlp output') };
  }

  const startOffsetSec = parseStartTime(raw);
  const formats = Array.isArray(data.formats) ? data.formats : [];
  const sourceMaxHeight = Number.isFinite(config.sourceMaxHeight) && config.sourceMaxHeight > 0
    ? Math.round(config.sourceMaxHeight)
    : 1080;
  // Prefer tracks at or below the output raster. If a provider exposes only
  // a larger rendition, retain it as a fallback instead of rejecting a
  // playable source outright.
  const cappedFormats = formats.filter((format) => {
    if (!format || format.vcodec === 'none') return true;
    return !Number.isFinite(format.height) || format.height <= sourceMaxHeight;
  });
  const selectableFormats = cappedFormats.some(format => format && format.vcodec !== 'none')
    ? cappedFormats
    : formats;
  const isLive = data.is_live === true || data.live_status === 'is_live';

  // "progressive" = a direct http(s) URL for a seekable file (not a manifest).
  // Two signals, in order:
  //   1. `protocol` from yt-dlp: 'https' / 'http' mean direct transfer;
  //      'm3u8_native' (DASH-over-HLS) and similar are manifests and are
  //      rejected. If `protocol` is absent (some tools/sources), fall back.
  //   2. URL shape: any .m3u8 / explicit hls_variant|hls_playlist manifest
  //      path is rejected unconditionally.
  const PROGRESSIVE_PROTOCOLS = new Set(['https', 'http']);
  const looksProgressive = (format) => {
    const proto = String(format && format.protocol || '').toLowerCase();
    if (proto && !PROGRESSIVE_PROTOCOLS.has(proto)) return false;
    const u = (format && format.url) || '';
    if (/\.m3u8(\?|&|#|$)/i.test(u)) return false;
    if (/\/index\.m3u8\b/i.test(u)) return false;
    if (/api\/manifest\/(hls_variant|hls_playlist)\b/i.test(u)) return false;
    return true;
  };

  // 1) Preferred: a combined A+V manifest (HLS/M3U8/DASH manifest) — progressive.
  let bestManifest = null;
  // 2) Next: a combined A+V single progressive URL (direct http(s) file).
  let bestDirect = null;
  for (const format of selectableFormats) {
    if (!isCombined(format)) continue;
    const hasManifest = typeof format.manifest_url === 'string' && format.manifest_url.length > 0;
    const hasDirect = typeof format.url === 'string' && format.url.length > 0;
    if (hasManifest) {
      if (!bestManifest || compareAVFormats(format, bestManifest, preferredLangs) < 0) bestManifest = format;
    } else if (hasDirect && looksProgressive(format)) {
      if (!bestDirect || compareAVFormats(format, bestDirect, preferredLangs) < 0) bestDirect = format;
    }
  }

  const vodDuration = !isLive && Number.isFinite(data.duration) && data.duration > 0 ? Math.round(data.duration) : null;

  if (bestManifest) {
    return {
      kind: 'ytdlp',
      streamType: 'single',
      streamUrl: bestManifest.manifest_url,
      title: data.title || null,
      available: true,
      startOffsetSec,
      isLive,
      totalDurationSec: vodDuration,
      note: 'combined A+V manifest (progressive, zero-disk)'
    };
  }

  if (bestDirect) {
    return {
      kind: 'ytdlp',
      streamType: 'single',
      streamUrl: bestDirect.url,
      title: data.title || null,
      available: true,
      startOffsetSec,
      isLive,
      totalDurationSec: vodDuration,
      note: 'combined A+V stream (progressive, zero-disk)'
    };
  }

  // 3) True separate V+A (DASH): pick best video + best audio progressive URLs
  //    each. The streamManager merges them in-memory (progressive), so this
  //    never touches disk.
  let bestVideo = null;
  for (const format of selectableFormats) {
    if (!format || format.vcodec === 'none') continue;
    const hasDirect = typeof format.url === 'string' && format.url.length > 0;
    if (!hasDirect || !looksProgressive(format)) continue;
    if (!bestVideo || compareFormats(format, bestVideo) < 0) bestVideo = format;
  }
  // Audio: prefer pure audio-only (vcodec==='none'); fall back to a combined
  // A+V progressive url as a last resort. Language-aware: a preferred-language
  // track beats a higher-bitrate foreign dub (see pickBestAudio).
  const pickAudio = (format) => !format || format.acodec === 'none'
    ? null
    : ((typeof format.url === 'string' && format.url.length > 0 && looksProgressive(format)) ? format : null);
  const pureAudio = [];
  for (const format of selectableFormats) {
    if (!format || format.vcodec !== 'none') continue;
    const cand = pickAudio(format);
    if (cand) pureAudio.push(cand);
  }
  let bestAudio = pickBestAudio(pureAudio, preferredLangs);
  if (!bestAudio) {
    const combinedAudio = [];
    for (const format of selectableFormats) {
      if (format && format.vcodec !== 'none') {
        const cand = pickAudio(format);
        if (cand) combinedAudio.push(cand);
      }
    }
    bestAudio = pickBestAudio(combinedAudio, preferredLangs);
  }
  if (bestAudio && config.verbose) {
    const audLang = String((bestAudio.language || bestAudio.alang) || '?');
    const audTbr = Number.isFinite(bestAudio.tbr) ? bestAudio.tbr : 'n/a';
    const audPref = bestAudio.language_preference != null ? bestAudio.language_preference : 'n/a';
    log('info', `audio track selected: language=${audLang} language_preference=${audPref} tbr=${audTbr} (prefs=${JSON.stringify(preferredLangs)})`);
  }

  if (bestVideo && bestAudio) {
    if (config.verbose) {
      log('info', `video track selected: codec=${normalizeVcodec(bestVideo.vcodec)} ` +
        `height=${bestVideo.height || '?'} tbr=${bestVideo.tbr || 'n/a'} maxHeight=${sourceMaxHeight}`);
    }
    return {
      kind: 'ytdlp',
      streamType: 'dash',
      videoUrl: bestVideo.url,
      audioUrl: bestAudio.url,
      title: data.title || null,
      available: true,
      startOffsetSec,
      isLive,
      totalDurationSec: vodDuration,
      note: 'separate A+V merged in-memory (progressive, zero-disk)'
    };
  }

  return { kind: 'ytdlp', available: false, note: M.STREAM_NO_PROGRESSIVE };
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

  const direct = resolveDirect(raw, cfg);
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
  ytdlpDumpJson,
  parseStartTime,
  parseSignedDuration,
  isLiveLikeUrl,
  // audio-format selection primitives (unit-tested directly):
  langRank,
  compareAVFormats
};
