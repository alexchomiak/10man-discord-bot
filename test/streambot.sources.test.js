'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveSource,
  resolveShareTv,
  resolveDirect,
  resolveYtdlp
} = require('../src/streambot/sources');
const { M } = require('../src/streambot/messages');
const { StreamManager, isBenignEnd } = require('../src/streambot/streamManager');

// ---- Fake yt-dlp binary ------------------------------------------------------
// Scenario-driven. The fake binary reads a SCENARIO file (default: "hls").
// It behaves like the relevant modes of the real `yt-dlp`:
//   * `--dump-json` -> prints ONE JSON line (the entry object) on stdout:
//                       hls       : combined A+V format WITH a manifest_url (HLS) + DASH lines
//                       single    : one combined A+V format with a direct url (no manifest)
//                       dash      : pure separate V+A (v-only + a-only) with direct urls, NO combined
//                       dashNoAudio: only a video-only format (no audio at all)
//                       dashNoVideo: only an audio-only format (no video at all)
//   * `-o <tmpl>`  -> "download": this fake rejects downloads entirely (exit 1),
//     because the bot must never download a source to disk. If a test observes an
//     `-o` argv in the sidecar log, resolution regressed to the old download path.
// It also appends each argv to a sidecar log so tests can assert exactly how
// yt-dlp was invoked (which mode, which URL, how many times) without the network.
let FAKE_BIN;
let FAKE_LOG;
let FAKE_DIR;
let FAKE_SCENARIO;

// Shared config for tests. ytdlpPath is set in before() (FAKE_BIN not known yet).
const CfgPlain = {
  shareTvBase: 'http://localhost:8080',
  shareTvAllowHosts: [],
  ytdlpPath: 'yt-dlp',
  ytdlpFormat: 'bv*+ba/b',
  ytdlpTimeoutMs: 20000,
  token: 'test-token'
};

before(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-fake-'));
  FAKE_BIN = path.join(dir, 'ytdlp-fake');
  FAKE_DIR = dir;
  FAKE_LOG = path.join(dir, 'argv.log');
  FAKE_SCENARIO = path.join(dir, 'scenario');
  fs.writeFileSync(FAKE_BIN, shebangScript());
  fs.chmodSync(FAKE_BIN, 0o755);
  setScenario('hls');
  // CfgPlain is defined at module load (before FAKE_BIN exists); point it at the
  // real fake binary now.
  CfgPlain.ytdlpPath = FAKE_BIN;
});
after(() => {
  // best-effort cleanup of the temp dir
  try {
    fs.rmSync(FAKE_DIR, { recursive: true, force: true });
  } catch { /* ignore */ }
});

// Switch the fake-yt-dlp behavior:
//   "hls"           = combined A+V format WITH a manifest_url (manifest streaming preferred)
//   "single"        = one combined A+V format with a direct url (no manifest)
//   "dash"          = pure separate V+A with direct urls (in-memory merge)
//   "dashNoAudio"   = video-only (no audio) -> must be rejected
//   "dashNoVideo"   = audio-only (no video) -> must be rejected
function setScenario(name) {
  fs.writeFileSync(FAKE_SCENARIO, String(name));
  return name;
}

function shebangScript() {
  return `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
const LOG = ${JSON.stringify(FAKE_LOG)};
const SC = ${JSON.stringify(FAKE_SCENARIO)};
try { fs.appendFileSync(LOG, JSON.stringify({ argv }) + '\\n'); } catch {}
let scenario = 'hls';
try { scenario = (fs.readFileSync(SC, 'utf8').trim() || 'hls'); } catch {}
const SCENARIOS = {
  youtubeHls: {
    duration: 8551,
    formats: [
      { protocol: 'https', vcodec: 'h264', acodec: 'none', height: 1080, url: 'https://cdn.example/video.mp4' },
      { protocol: 'https', vcodec: 'none', acodec: 'opus', language: 'en', url: 'https://cdn.example/audio.webm' },
      { protocol: 'm3u8_native', vcodec: 'h264', acodec: 'none', height: 1080, url: 'https://manifest.googlevideo.com/api/manifest/hls_playlist/video/index.m3u8' },
      { protocol: 'm3u8_native', vcodec: 'h264', acodec: 'none', height: 2160, url: 'https://manifest.googlevideo.com/api/manifest/hls_playlist/4k/index.m3u8' },
      { protocol: 'm3u8_native', vcodec: 'none', acodec: null, language: 'en', tbr: 128, url: 'https://manifest.googlevideo.com/api/manifest/hls_playlist/audio/index.m3u8' },
      { protocol: 'm3u8_native', vcodec: 'none', acodec: null, language: 'ar', tbr: 256, url: 'https://manifest.googlevideo.com/api/manifest/hls_playlist/arabic/index.m3u8' }
    ]
  },
  hls: {
    duration: 3661,
    title: 'HLS VOD',
    formats: [
      { format_id: 'hls1', vcodec: 'h264', acodec: 'mp4a', height: 1080, tbr: 1000, manifest_url: 'https://manifest.example/hls/master.m3u8' },
      { format_id: 'dashV', vcodec: 'h264', acodec: 'none', height: 1080 },
      { format_id: 'dashA', vcodec: 'none', acodec: 'mp4a' }
    ]
  },
  // Combined A+V manifests in TWO languages (both with manifest_url). en is the
  // original (lower tbr); the Arabic dub has a HIGHER tbr. audioLang must make
  // the bot pick the English manifest, not the higher-bitrate Arabic one.
  hlsMulti: {
    duration: 3661,
    title: 'HLS MULTI',
    formats: [
      { format_id: 'hls1', vcodec: 'h264', acodec: 'mp4a', height: 1080, tbr: 1000, language: 'en', language_preference: 0, manifest_url: 'https://manifest.example/hls/master.m3u8' },
      { format_id: 'hls2', vcodec: 'h264', acodec: 'mp4a', height: 1080, tbr: 3000, language: 'ar', language_preference: 2, manifest_url: 'https://manifest.example/hls/ar.m3u8' }
    ]
  },
  single: {
    duration: null,
    title: 'Live',
    formats: [
      { format_id: 'live1', vcodec: 'h264', acodec: 'mp4a', url: 'https://cdn.example/fake/combined.mp4' }
    ]
  },
  dash: {
    duration: 820,
    title: 'DASH VOD',
    formats: [
      { format_id: '270', vcodec: 'avc1.640028', acodec: 'none', height: 1080, tbr: 2767, url: 'https://cdn.example/fake/video.mp4' },
      { format_id: '140', vcodec: 'none', acodec: 'mp4a.40.2', tbr: 129, url: 'https://cdn.example/fake/audio.m4a' }
    ]
  },
  liveDash4k: {
    is_live: true,
    live_status: 'is_live',
    duration: null,
    title: 'LIVE DASH',
    formats: [
      { format_id: '401', protocol: 'https', vcodec: 'av01.0.12M.08', acodec: 'none', height: 2160, tbr: 12000, url: 'https://cdn.example/live/video-4k.mp4' },
      { format_id: '137', protocol: 'https', vcodec: 'avc1.640028', acodec: 'none', height: 1080, tbr: 5000, url: 'https://cdn.example/live/video-1080.mp4' },
      { format_id: '140', protocol: 'https', vcodec: 'none', acodec: 'mp4a.40.2', tbr: 128, url: 'https://cdn.example/live/audio.m4a' }
    ]
  },
  dashNoAudio: {
    duration: 300,
    title: 'Video Only',
    formats: [
      { format_id: 'v1', vcodec: 'avc1.640028', acodec: 'none', height: 720, tbr: 1500, url: 'https://cdn.example/fake/videoonly.mp4' }
    ]
  },
  dashNoVideo: {
    duration: 300,
    title: 'Audio Only',
    formats: [
      { format_id: 'a1', vcodec: 'none', acodec: 'mp4a.40.2', tbr: 129, url: 'https://cdn.example/fake/audioonly.m4a' }
    ]
  },
  // One video track + three KNOWN-language audio tracks, no original/unknown
  // track. en is low bitrate; ar and es are higher-bitrate foreign dubs.
  multidub: {
    duration: 900,
    title: 'MULTI DUB',
    formats: [
      { format_id: 'V', protocol: 'https', vcodec: 'avc1.640028', acodec: 'none', height: 1080, tbr: 2767, url: 'https://cdn.example/multi/video.mp4' },
      { format_id: 'A_en', protocol: 'https', vcodec: 'none', acodec: 'mp4a.40.2', tbr: 129, language: 'en', language_preference: 0, url: 'https://cdn.example/multi/a_en.m4a' },
      { format_id: 'A_ar', protocol: 'https', vcodec: 'none', acodec: 'mp4a.40.2', tbr: 192, language: 'ar', language_preference: 2, url: 'https://cdn.example/multi/a_ar.m4a' },
      { format_id: 'A_es', protocol: 'https', vcodec: 'none', acodec: 'mp4a.40.2', tbr: 256, language: 'es', language_preference: 1, url: 'https://cdn.example/multi/a_es.m4a' }
    ]
  },
  // REAL yt-dlp shape (no alang at all — the field does not exist in real
  // dumps). en original ~130k; ar and es dubs are HIGHER-bitrate (~250k/180k).
  // With the default audioLang ['en'] the English original MUST win even though
  // the foreign dubs have higher tbr. language_preference mirrors real YouTube.
  realytdlp: {
    duration: 600,
    title: 'REAL YTDLP SHAPE',
    formats: [
      { format_id: 'V', protocol: 'https', vcodec: 'avc1.640028', acodec: 'none', height: 1080, tbr: 2767, url: 'https://cdn.example/real/video.mp4' },
      { format_id: 'A_en', protocol: 'https', vcodec: 'none', acodec: 'mp4a.40.2', tbr: 130, language: 'en', language_preference: 0, url: 'https://cdn.example/real/a_en.m4a' },
      { format_id: 'A_ar', protocol: 'https', vcodec: 'none', acodec: 'mp4a.40.2', tbr: 250, language: 'ar', language_preference: 3, url: 'https://cdn.example/real/a_ar.m4a' },
      { format_id: 'A_es', protocol: 'https', vcodec: 'none', acodec: 'mp4a.40.2', tbr: 180, language: 'es', language_preference: 1, url: 'https://cdn.example/real/a_es.m4a' }
    ]
  },
  // Same as multidub but with an ORIGINAL/unknown track listed FIRST (no
  // language), followed by the three known-language dubs. Exercises the
  // "original/first-listed" fallback tier (ranks above non-preferred known
  // languages).
  multidubOrig: {
    duration: 900,
    title: 'MULTI DUB ORIG',
    formats: [
      { format_id: 'V', protocol: 'https', vcodec: 'avc1.640028', acodec: 'none', height: 1080, tbr: 2767, url: 'https://cdn.example/multi/video.mp4' },
      { format_id: 'A_orig', protocol: 'https', vcodec: 'none', acodec: 'mp4a.40.2', tbr: 64, url: 'https://cdn.example/multi/a_orig.m4a' },
      { format_id: 'A_en', protocol: 'https', vcodec: 'none', acodec: 'mp4a.40.2', tbr: 129, language: 'en', language_preference: 0, url: 'https://cdn.example/multi/a_en.m4a' },
      { format_id: 'A_ar', protocol: 'https', vcodec: 'none', acodec: 'mp4a.40.2', tbr: 192, language: 'ar', language_preference: 2, url: 'https://cdn.example/multi/a_ar.m4a' },
      { format_id: 'A_es', protocol: 'https', vcodec: 'none', acodec: 'mp4a.40.2', tbr: 256, language: 'es', language_preference: 1, url: 'https://cdn.example/multi/a_es.m4a' }
    ]
  }
};
if (argv.includes('--dump-json')) {
  const obj = scenario.startsWith('youtubeHls') ? SCENARIOS.youtubeHls : (SCENARIOS[scenario] || SCENARIOS.hls);
  if (scenario === 'youtubeHlsLive') obj.is_live = true;
  if (scenario === 'youtubeHlsLow') obj.formats[2].height = 720;
  if (scenario === 'youtubeHlsNoAudio') obj.formats = obj.formats.slice(0, 4);
  if (scenario === 'youtubeHlsForeign') obj.formats.splice(4, 1);
  if (scenario === 'youtubeHlsUnknown') {
    obj.formats[4].tbr = null;
    obj.formats.unshift({ ...obj.formats[4], url: 'https://manifest.googlevideo.com/api/manifest/hls_playlist/low-audio/index.m3u8' });
  }
  process.stdout.write(JSON.stringify(obj) + '\\n');
  process.exit(0);
}
// Any other invocation (including -o downloads) is rejected: the bot must
// never ask yt-dlp to download to disk.
process.stderr.write('fake yt-dlp: unexpected invocation (downloads forbidden)\\n');
process.exit(1);
`;
}

function readFakeLog() {
  try {
    const txt = fs.readFileSync(FAKE_LOG, 'utf8');
    return txt.trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// Classify each recorded yt-dlp invocation: "dump" (--dump-json), "download" (-o), or unknown.
function fakeCalls() {
  return readFakeLog().map((e) => ({
    argv: e.argv,
    mode: e.argv.includes('-o') ? 'download' : (e.argv.includes('--dump-json') ? 'dump' : 'unknown'),
    url: e.argv.filter((a) => /^https?:\/\//.test(a))[0] || null
  }));
}

const BASE = 'http://localhost:8080';
const SLUG = 'dlp-test';
const SIGNED_HLS = `${BASE}/api/public/stream/${SLUG}?viewer=AAAA&vsig=BBBB&hls=1`;
const SIGNED_RAW = `${BASE}/api/public/stream/${SLUG}?viewer=CCCC&vsig=DDDD`;

const SHARE_ORDINARY = {
  slug: SLUG,
  stream_available: true,
  stream_kind: 'mpegts',
  stream_url: SIGNED_RAW,
  hls_url: SIGNED_HLS
};

const SHARE_PLATFORM = {
  slug: 'tw-test',
  stream_available: true,
  stream_kind: 'platform',
  media_url: 'https://twitch.tv/example',
  stream_url: `${BASE}/api/public/stream/tw-test?viewer=E&vsig=F`
};

const SHARE_UNAVAILABLE = {
  slug: 'off',
  stream_available: false,
  stream_url: null,
  hls_url: null
};

// ---- Test helpers ------------------------------------------------------------
async function withShare(share, fn) {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (/\/api\/public\/share\//.test(String(url))) {
      return {
        status: 200,
        ok: true,
        json: async () => ({ share })
      };
    }
    throw new Error('unexpected fetch: ' + url);
  };
  try {
    return await fn();
  } finally {
    global.fetch = realFetch;
  }
}

// ============================================================================
// 1) Selection order: media_url || stream_url || hls_url
// ============================================================================
test('selection: absent media_url -> stream_url chosen over hls_url (no yt-dlp)', async () => {
  await withShare(SHARE_ORDINARY, async () => {
    const res = await resolveSource(SLUG, CfgPlain);
    assert.strictEqual(res.kind, 'sharetv');
    assert.strictEqual(res.available, true);
    assert.strictEqual(
      res.streamUrl,
      SIGNED_RAW,
      'must pick stream_url (continuous MPEG-TS) before hls_url — the library misdetects our hls_url as non-HLS and hangs reconnect-looping'
    );
  });
  const log = readFakeLog();
  assert.strictEqual(log.length, 0, 'yt-dlp must NOT be invoked for ordinary share');
});

test('selection: media_url present -> media_url chosen and yt-dlp IS invoked (single stream)', async () => {
  setScenario('single'); // Twitch single combined stream: one --dump-json probe, no download
  const before_calls = readFakeLog().length;
  await withShare(SHARE_PLATFORM, async () => {
    const res = await resolveSource('tw-test', CfgPlain);
    assert.strictEqual(res.kind, 'sharetv');
    assert.strictEqual(res.available, true);
    assert.strictEqual(res.streamUrl, 'https://cdn.example/fake/combined.mp4');
    assert.strictEqual(res.streamType, 'single');
    assert.strictEqual(res.localFile, undefined, 'no local-file fields anymore (zero-disk)');
    assert.strictEqual(res.localDir, undefined);
  });
  const calls = fakeCalls().slice(before_calls);
  assert.strictEqual(calls.length, 1, 'exactly one yt-dlp call (--dump-json, no download) for a single platform stream');
  assert.strictEqual(calls[0].mode, 'dump');
  assert.strictEqual(calls[0].url, 'https://twitch.tv/example');
  const runtimeIndex = calls[0].argv.indexOf('--js-runtimes');
  assert.ok(runtimeIndex >= 0, 'yt-dlp must be given the JavaScript runtime bundled in the image');
  assert.strictEqual(calls[0].argv[runtimeIndex + 1], 'node');
});

test('selection: media_url absent, hls_url absent -> stream_url chosen', async () => {
  const share = { slug: 'raw', stream_available: true, stream_kind: 'mpegts', stream_url: SIGNED_RAW };
  await withShare(share, async () => {
    const res = await resolveSource('raw', CfgPlain);
    assert.strictEqual(res.streamUrl, SIGNED_RAW);
  });
});

// ============================================================================
// 2) Signed URL preservation (viewer + vsig, plus any future query params)
// ============================================================================
test('preserves signed query string (viewer, vsig) verbatim', async () => {
  await withShare(SHARE_ORDINARY, async () => {
    const res = await resolveSource(SLUG, CfgPlain);
    const u = new URL(res.streamUrl);
    assert.strictEqual(u.pathname, `/api/public/stream/${SLUG}`);
    assert.strictEqual(u.searchParams.get('viewer'), 'CCCC');
    assert.strictEqual(u.searchParams.get('vsig'), 'DDDD');
    // exact raw string is preserved — no parameter reordering or dropping.
    assert.strictEqual(res.streamUrl, SIGNED_RAW);
  });
});

test('preserves any future query params verbatim', async () => {
  const share = {
    slug: 'future',
    stream_available: true,
    stream_kind: 'mpegts',
    stream_url: `${BASE}/api/public/stream/future?viewer=F1&vsig=F2&event=42&x_new=abc`
  };
  await withShare(share, async () => {
    const res = await resolveSource('future', CfgPlain);
    const u = new URL(res.streamUrl);
    assert.strictEqual(u.searchParams.get('event'), '42');
    assert.strictEqual(u.searchParams.get('x_new'), 'abc');
    assert.strictEqual(res.streamUrl, share.stream_url);
  });
});

// ============================================================================
// 3) Ordinary IPTV shares bypass yt-dlp entirely (the real network call
//    never happens because the ShareTv path returns before resolveYtdlp)
// ============================================================================
test('ordinary share -> no yt-dlp call (verified by sidecar log)', async () => {
  const before = readFakeLog().length;
  await withShare(SHARE_ORDINARY, async () => {
    await resolveSource(SLUG, CfgPlain);
  });
  const after = readFakeLog().length;
  assert.strictEqual(after, before, 'yt-dlp must not be invoked for ordinary shares');
});

// ============================================================================
// 4) resolveDirect: accepts signed URLs (u/sig OR viewer/vsig), rejects platform
//    pages (which route to yt-dlp)
// ============================================================================
test('resolveDirect: accepts signed stream URL (viewer/vsig)', () => {
  const res = resolveDirect(SHARE_ORDINARY.stream_url);
  assert.ok(res, 'signed stream_url is accepted as direct');
  assert.strictEqual(res.kind, 'direct');
  assert.strictEqual(res.streamUrl, SHARE_ORDINARY.stream_url);
  assert.strictEqual(res.isLive, true, 'signed ShareTV MPEG-TS endpoint is a live feed');
});

test('resolveDirect: accepts signed stream URL (u/sig)', () => {
  const signed = `${BASE}/api/public/stream/x?u=abc&sig=xyz`;
  const res = resolveDirect(signed);
  assert.ok(res);
  assert.strictEqual(res.streamUrl, signed);
  assert.strictEqual(res.isLive, true, 'legacy signed ShareTV endpoint is also live');
});

test('resolveDirect: rejects raw platform page (not direct; routes to yt-dlp)', () => {
  assert.strictEqual(resolveDirect('https://twitch.tv/foo'), null);
  assert.strictEqual(resolveDirect('https://www.youtube.com/watch?v=abc'), null);
});

test('resolveDirect: accepts native media URL by extension', () => {
  const r = resolveDirect('https://cdn.example/live/master.m3u8');
  assert.ok(r);
  assert.strictEqual(r.streamUrl, 'https://cdn.example/live/master.m3u8');
});

test('resolveDirect: loopback-pinned signed URL rewritten to SHARETV_BASE host (Docker case)', () => {
  const cfg = { shareTvBase: 'http://host.docker.internal:8080' };
  const res = resolveDirect(
    'http://localhost:8080/api/public/stream/dlp-test?viewer=AAAA&vsig=BBBB&hls=1',
    cfg
  );
  assert.ok(res, 'signed stream URL must be accepted as direct');
  assert.strictEqual(res.kind, 'direct');
  assert.strictEqual(
    res.streamUrl,
    'http://host.docker.internal:8080/api/public/stream/dlp-test?viewer=AAAA&vsig=BBBB&hls=1',
    'loopback host must be rewritten to SHARETV_BASE, path+query preserved'
  );
});

test('resolveDirect: 127.0.0.1-pinned URL rewritten to SHARETV_BASE host', () => {
  const res = resolveDirect(
    'http://127.0.0.1:8080/live/master.m3u8',
    { shareTvBase: 'http://192.168.0.37:8080' }
  );
  assert.strictEqual(res.streamUrl, 'http://192.168.0.37:8080/live/master.m3u8');
});

test('resolveDirect: unchanged when SHARETV_BASE unset (bare-process deployment)', () => {
  const url = 'http://localhost:8080/api/public/stream/x?viewer=A&vsig=B';
  assert.strictEqual(resolveDirect(url, {}).streamUrl, url);
  assert.strictEqual(resolveDirect(url).streamUrl, url);
});

test('resolveDirect: unchanged when URL host already matches SHARETV_BASE', () => {
  const url = 'http://localhost:8080/api/public/stream/x?viewer=A&vsig=B';
  assert.strictEqual(resolveDirect(url, { shareTvBase: 'http://localhost:8080' }).streamUrl, url);
});

test('resolveDirect: non-loopback foreign host NOT rewritten (still plays as-is)', () => {
  const cfg = { shareTvBase: 'http://host.docker.internal:8080' };
  const url = 'http://192.168.0.37:8080/api/public/stream/x?viewer=A&vsig=B';
  assert.strictEqual(resolveDirect(url, cfg).streamUrl, url);
});

// ============================================================================
// 5) Relative URL backward compatibility
// ============================================================================
test('relative hls_url / stream_url resolved against base (new URL)', async () => {
  const share = {
    slug: 'rel',
    stream_available: true,
    stream_kind: 'mpegts',
    stream_url: '/api/public/stream/rel?viewer=R1&vsig=R2',
    hls_url: '/api/public/stream/rel?viewer=R1&vsig=R2&hls=1'
  };
  await withShare(share, async () => {
    const res = await resolveSource('rel', CfgPlain);
    assert.strictEqual(
      res.streamUrl,
      `${BASE}/api/public/stream/rel?viewer=R1&vsig=R2`,
      'relative stream_url must be resolved against IPTV_SHARE_BASE (and preferred over hls_url)'
    );
  });
});

test('absolute stream_url passes through unchanged (contract: "absolute playback URLs")', async () => {
  await withShare(SHARE_ORDINARY, async () => {
    const res = await resolveSource(SLUG, CfgPlain);
    assert.ok(res.streamUrl.startsWith('http://'), 'absolute URL must be returned as-is');
    assert.strictEqual(res.streamUrl, SHARE_ORDINARY.stream_url);
  });
});

test('host rewrite: localhost-pinned stream_url rewritten to SHARETV_BASE host', async () => {
  const cfg = { ...CfgPlain, shareTvBase: 'http://host.docker.internal:8080' };
  const share = {
    slug: 'x',
    stream_available: true,
    stream_kind: 'mpegts',
    stream_url: 'http://localhost:8080/api/public/stream/x?viewer=abc&vsig=def'
  };
  await withShare(share, async () => {
    const res = await resolveShareTv('x', cfg);
    assert.strictEqual(res.kind, 'sharetv');
    assert.strictEqual(res.available, true);
    assert.strictEqual(
      res.streamUrl,
      'http://host.docker.internal:8080/api/public/stream/x?viewer=abc&vsig=def',
      'localhost-pinned host must be rewritten to SHARETV_BASE, path+query preserved'
    );
  });
});

// ============================================================================
// 6) Failure modes
// ============================================================================
test('share missing -> clean reject', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ status: 404, ok: false, json: async () => null });
  try {
    const res = await resolveSource(SLUG, CfgPlain);
    assert.strictEqual(res.available, false);
    assert.match(res.note, /not (found|find)/i);
  } finally {
    global.fetch = realFetch;
  }
});

test('stream_available:false -> clean reject (no yt-dlp call)', async () => {
  const before = readFakeLog().length;
  await withShare(SHARE_UNAVAILABLE, async () => {
    const res = await resolveSource('off', CfgPlain);
    assert.strictEqual(res.available, false);
  });
  assert.strictEqual(readFakeLog().length, before);
});

test('all of media_url/hls_url/stream_url absent -> clean reject', async () => {
  const share = { slug: 'none', stream_available: true, stream_kind: 'mpegts' };
  await withShare(share, async () => {
    const res = await resolveSource('none', CfgPlain);
    assert.strictEqual(res.available, false);
    assert.match(res.note, /event|media|url|source/i);
  });
});

test('yt-dlp failure (ENOENT) -> clean reject note', async () => {
  setScenario('hls');
  const cfg = { ...CfgPlain, ytdlpPath: '/nonexistent/yt-dlp' };
  const res = await resolveDirect('https://twitch.tv/foo'); // confirm direct rejects
  assert.strictEqual(res, null);
  const ytdlp = await Promise.resolve(resolveYtdlp('https://twitch.tv/foo', cfg));
  assert.strictEqual(ytdlp.available, false);
  assert.match(ytdlp.note, /yt-dlp/i);
});

// ============================================================================
// 6b) SHARETV_BASE unset: /s/<slug> links must get a friendly "set SHARETV_BASE"
//     note and must NEVER fall through to yt-dlp (which would produce a
//     misleading "could not resolve that URL" error).
// ============================================================================
test('guard: /s/<slug> URL with SHARETV_BASE unset -> friendly note, yt-dlp NOT invoked', async () => {
  const before = readFakeLog().length;
  const res = await resolveSource('http://example.com/s/foo', {
    shareTvBase: null,
    shareTvAllowHosts: [],
    ytdlpPath: FAKE_BIN
  });
  assert.strictEqual(res.kind, 'sharetv');
  assert.strictEqual(res.available, false);
  assert.match(res.note, /SHARETV_BASE/);
  assert.strictEqual(readFakeLog().length, before, 'yt-dlp must not be invoked for an unconfigured share link');
});

test('guard: bare slug with SHARETV_BASE unset -> friendly note, yt-dlp NOT invoked', async () => {
  const before = readFakeLog().length;
  const res = await resolveSource('dlp-test', {
    shareTvBase: null,
    shareTvAllowHosts: [],
    ytdlpPath: FAKE_BIN
  });
  assert.strictEqual(res.kind, 'sharetv');
  assert.strictEqual(res.available, false);
  assert.match(res.note, /SHARETV_BASE/);
  assert.strictEqual(readFakeLog().length, before, 'yt-dlp must not be invoked for an unconfigured bare slug');
});

test('guard: /s/<slug> on host NOT matching SHARETV_BASE -> no yt-dlp fallthrough', async () => {
  const before = readFakeLog().length;
  const res = await resolveSource('https://example.com/s/foo', {
    shareTvBase: 'http://other-base:8080',
    shareTvAllowHosts: [],
    ytdlpPath: FAKE_BIN
  });
  assert.strictEqual(res.kind, 'sharetv');
  assert.strictEqual(res.available, false);
  assert.match(res.note, /SHARETV_BASE/);
  assert.strictEqual(readFakeLog().length, before, 'yt-dlp must not see a host-mismatched share link');
});

test('guard positive control: /s/<slug> matching SHARETV_BASE still resolves (no false positive)', async () => {
  await withShare(SHARE_ORDINARY, async () => {
    const res = await resolveSource('http://example.com/s/dlp-test', {
      shareTvBase: 'http://example.com',
      shareTvAllowHosts: [],
      ytdlpPath: FAKE_BIN
    });
    assert.strictEqual(res.kind, 'sharetv');
    assert.strictEqual(res.available, true);
    // stream_url is pinned to localhost but the share was fetched from
    // http://example.com — the loopback host is rewritten to the base.
    assert.strictEqual(
      res.streamUrl,
      SHARE_ORDINARY.stream_url.replace('http://localhost:8080', 'http://example.com')
    );
  });
});

// ============================================================================
// 7) Three-path yt-dlp strategy (ALL progressive, ZERO disk):
//     * combined A+V manifest_url  -> stream the manifest URL (single)
//     * combined A+V direct url    -> stream the url directly (single)
//     * separate V+A (DASH) urls   -> streamType 'dash' (in-memory merge)
//     * nothing progressive        -> rejected (never downloaded)
// ============================================================================
test('hls: manifest_url present -> streamType single, stream the manifest URL (no download)', async () => {
  setScenario('hls');
  const before = readFakeLog().length;
  const res = await resolveYtdlp('https://www.youtube.com/watch?v=HLSVOD', CfgPlain);
  assert.strictEqual(res.kind, 'ytdlp');
  assert.strictEqual(res.available, true);
  assert.strictEqual(res.streamType, 'single');
  assert.strictEqual(res.streamUrl, 'https://manifest.example/hls/master.m3u8');
  assert.strictEqual(res.localFile, undefined, 'no local-file fields anymore (zero-disk)');
  assert.strictEqual(res.localDir, undefined);
  assert.strictEqual(res.startOffsetSec, null, 'no &t= on the URL -> no offset');

  const calls = fakeCalls().slice(before);
  assert.strictEqual(calls.length, 1, 'HLS: exactly ONE yt-dlp call');
  assert.strictEqual(calls[0].mode, 'dump', 'HLS: the call must be --dump-json (not -g, not -o)');
  assert.ok(!calls.some((c) => c.argv.includes('-o')), 'HLS: no download (-o) must happen');
});

test('single: combined direct url -> streamType single, stream the direct URL (no download)', async () => {
  setScenario('single');
  const before = readFakeLog().length;
  const res = await resolveYtdlp('https://twitch.tv/somestreamer', CfgPlain);
  assert.strictEqual(res.kind, 'ytdlp');
  assert.strictEqual(res.available, true);
  assert.strictEqual(res.streamType, 'single');
  assert.strictEqual(res.streamUrl, 'https://cdn.example/fake/combined.mp4');
  assert.strictEqual(res.localFile, undefined, 'single stream must be a direct remote URL');
  assert.strictEqual(res.localDir, undefined);

  const calls = fakeCalls().slice(before);
  assert.strictEqual(calls.length, 1, 'single stream: exactly ONE yt-dlp call (--dump-json)');
  assert.strictEqual(calls[0].mode, 'dump');
  assert.ok(!calls.some((c) => c.argv.includes('-o')), 'single: no download (-o) must happen');
});

test('dash: separate V+A -> streamType dash with progressive videoUrl+audioUrl, NEVER downloaded', async () => {
  setScenario('dash');
  const before = readFakeLog().length;
  const res = await resolveYtdlp('https://www.youtube.com/watch?v=DASHVOD', CfgPlain);
  assert.strictEqual(res.kind, 'ytdlp');
  assert.strictEqual(res.available, true, 'DASH is now progressive — it must be available');
  assert.strictEqual(res.streamType, 'dash');
  assert.strictEqual(res.videoUrl, 'https://cdn.example/fake/video.mp4');
  assert.strictEqual(res.audioUrl, 'https://cdn.example/fake/audio.m4a');
  assert.strictEqual(res.streamUrl, undefined, 'a dash source has no single streamUrl');
  assert.strictEqual(res.localFile, undefined, 'DASH must never be downloaded to a local file');
  assert.strictEqual(res.localDir, undefined);

  const calls = fakeCalls().slice(before);
  assert.strictEqual(calls.length, 1, 'DASH: exactly ONE yt-dlp call (--dump-json)');
  assert.strictEqual(calls[0].mode, 'dump');
  assert.ok(!calls.some((c) => c.argv.includes('-o')), 'DASH: NO download (-o) must happen — core regression');
});

test('YouTube VOD uses capped segmented tracks with preferred audio and preserves seeking', async () => {
  for (const scenario of ['youtubeHls', 'youtubeHlsUnknown']) {
    setScenario(scenario);
    const res = await resolveYtdlp('https://www.youtube.com/watch?v=VOD&t=3600', CfgPlain);
    assert.equal(res.streamType, 'dash');
    assert.match(res.videoUrl, /hls_playlist\/video\//);
    assert.match(res.audioUrl, /hls_playlist\/audio\//);
    assert.equal(res.isLive, false);
    assert.equal(res.totalDurationSec, 8551);
    assert.equal(res.startOffsetSec, 3600);
    assert.equal(res.localFile, undefined);
  }
});

test('YouTube HLS preference does not alter live or reduce resolution or lose audio', async () => {
  for (const scenario of ['youtubeHlsLive', 'youtubeHlsLow', 'youtubeHlsNoAudio', 'youtubeHlsForeign']) {
    setScenario(scenario);
    const res = await resolveYtdlp('https://www.youtube.com/watch?v=VOD', CfgPlain);
    assert.equal(res.videoUrl, 'https://cdn.example/video.mp4', scenario);
    assert.equal(res.audioUrl, 'https://cdn.example/audio.webm', scenario);
  }
});

test('live DASH: preserves live status and selects a 1080p H.264 track instead of 4K', async () => {
  setScenario('liveDash4k');
  const res = await resolveYtdlp('https://www.youtube.com/watch?v=LIVE', {
    ...CfgPlain,
    sourceMaxHeight: 1080
  });
  assert.strictEqual(res.available, true);
  assert.strictEqual(res.streamType, 'dash');
  assert.strictEqual(res.isLive, true);
  assert.strictEqual(res.totalDurationSec, null);
  assert.strictEqual(res.videoUrl, 'https://cdn.example/live/video-1080.mp4');
  assert.strictEqual(res.audioUrl, 'https://cdn.example/live/audio.m4a');
});

test('dashNoAudio: video-only source (no audio) -> rejected, NO download', async () => {
  setScenario('dashNoAudio');
  const before = readFakeLog().length;
  const res = await resolveYtdlp('https://www.youtube.com/watch?v=NOAUDIO', CfgPlain);
  assert.strictEqual(res.kind, 'ytdlp');
  assert.strictEqual(res.available, false, 'no audio -> nothing playable -> reject');
  assert.match(res.note, /progressive|download/i, 'note must say it would need a download / lacks progressive A+V');
  assert.ok(!res.localDir, 'no localDir may exist');

  const calls = fakeCalls().slice(before);
  assert.strictEqual(calls.length, 1, 'video-only must ONLY call yt-dlp once (--dump-json)');
  assert.strictEqual(calls[0].mode, 'dump');
  assert.ok(!calls.some((c) => c.argv.includes('-o')), 'video-only must NOT trigger a download');
});

test('dashNoVideo: audio-only source (no video) -> rejected, NO download', async () => {
  setScenario('dashNoVideo');
  const before = readFakeLog().length;
  const res = await resolveYtdlp('https://www.youtube.com/watch?v=NOVIDEO', CfgPlain);
  assert.strictEqual(res.kind, 'ytdlp');
  assert.strictEqual(res.available, false, 'no video -> nothing playable -> reject');
  assert.match(res.note, /progressive|download/i, 'note must say it would need a download / lacks progressive A+V');
  assert.ok(!res.localDir, 'no localDir may exist');

  const calls = fakeCalls().slice(before);
  assert.strictEqual(calls.length, 1, 'audio-only must ONLY call yt-dlp once (--dump-json)');
  assert.strictEqual(calls[0].mode, 'dump');
  assert.ok(!calls.some((c) => c.argv.includes('-o')), 'audio-only must NOT trigger a download');
});

test('DASH via ShareTV platform share -> videoUrl/audioUrl propagate, NO download', async () => {
  setScenario('dash');
  const before = readFakeLog().length;
  await withShare(SHARE_PLATFORM, async () => {
    const res = await resolveSource('tw-test', CfgPlain);
    assert.strictEqual(res.kind, 'sharetv');
    assert.strictEqual(res.available, true);
    assert.strictEqual(res.streamType, 'dash');
    assert.strictEqual(res.videoUrl, 'https://cdn.example/fake/video.mp4');
    assert.strictEqual(res.audioUrl, 'https://cdn.example/fake/audio.m4a');
    assert.strictEqual(res.streamUrl, undefined);
    assert.ok(!/^https?:\/\//.test(String(res.localDir || '')), 'no local file of any kind');
  });
  const calls = fakeCalls().slice(before);
  assert.ok(calls.every((c) => !c.argv.includes('-o')), 'a DASH platform share must NOT trigger a download');
});

// ============================================================================
// 8a) AUDIO-LANGUAGE PREFERENCE (multi-dub DASH + combined A+V):
//      a preferred-language track must beat a higher-bitrate foreign dub.
// ============================================================================
test('multidub (known languages only): audioLang=[en] -> English track wins even though ar/es have higher tbr', async () => {
  setScenario('multidub');
  const cfg = { ...CfgPlain, audioLang: ['en'] };
  const res = await resolveYtdlp('https://www.youtube.com/watch?v=MULTIDUB', cfg);
  assert.strictEqual(res.kind, 'ytdlp');
  assert.strictEqual(res.available, true);
  assert.strictEqual(res.streamType, 'dash');
  // English (129kbps) must be chosen over the higher-bitrate ar (192) / es (256).
  assert.strictEqual(res.audioUrl, 'https://cdn.example/multi/a_en.m4a');
  assert.strictEqual(res.videoUrl, 'https://cdn.example/multi/video.mp4');
});

test('multidub (known languages only): audioLang=[] (no code preference) -> the original/default track (language_preference 0) wins over higher-bitrate dubs', async () => {
  setScenario('multidub');
  const cfg = { ...CfgPlain, audioLang: [] };
  const res = await resolveYtdlp('https://www.youtube.com/watch?v=MULTIDUB', cfg);
  assert.strictEqual(res.available, true);
  assert.strictEqual(res.streamType, 'dash');
  // No code preference -> the track the platform itself ranks as original/default
  // (language_preference 0, the lowest) wins, even though ar/es have higher tbr.
  assert.strictEqual(res.audioUrl, 'https://cdn.example/multi/a_en.m4a');
});

test('multidub: audioLang default (key absent -> [en]) still prefers English', async () => {
  setScenario('multidub');
  const cfg = { ...CfgPlain };
  delete cfg.audioLang;
  const res = await resolveYtdlp('https://www.youtube.com/watch?v=MULTIDUB', cfg);
  assert.strictEqual(res.available, true);
  assert.strictEqual(res.audioUrl, 'https://cdn.example/multi/a_en.m4a');
});

test('multidub (original listed first): audioLang=[] -> the original/first-listed track is chosen over known dubs', async () => {
  setScenario('multidubOrig');
  const cfg = { ...CfgPlain, audioLang: [] };
  const res = await resolveYtdlp('https://www.youtube.com/watch?v=MULTIDUBORIG', cfg);
  assert.strictEqual(res.available, true);
  assert.strictEqual(res.streamType, 'dash');
  // The unknown/original track (first-listed) ranks above non-preferred known
  // languages even though it has the lowest bitrate (64 < 129/192/256).
  assert.strictEqual(res.audioUrl, 'https://cdn.example/multi/a_orig.m4a');
});

test('multidub (original listed first): audioLang=[en] -> English still beats the original (preferred > original)', async () => {
  setScenario('multidubOrig');
  const cfg = { ...CfgPlain, audioLang: ['en'] };
  const res = await resolveYtdlp('https://www.youtube.com/watch?v=MULTIDUBORIG', cfg);
  assert.strictEqual(res.available, true);
  assert.strictEqual(res.audioUrl, 'https://cdn.example/multi/a_en.m4a');
});

test('langRank: preferred < unknown/original < non-preferred (by list position)', () => {
  const { langRank } = require('../src/streambot/sources');
  const prefs = ['en', 'es'];
  assert.strictEqual(langRank({ alang: 'en' }, prefs), 0, 'first preferred = rank 0');
  assert.strictEqual(langRank({ alang: 'es' }, prefs), 1, 'second preferred = rank 1 (position)');
  assert.strictEqual(langRank({ alang: 'EN' }, prefs), 0, 'case-insensitive match');
  assert.strictEqual(langRank({ alang: 'ar' }, prefs), 2000, 'known non-preferred = high rank');
  assert.ok(langRank({ alang: 'fr' }, prefs) >= 2000, 'other known = high rank');
  // unknown / original ranks above non-preferred, below preferred
  const unk = langRank({}, prefs);
  assert.strictEqual(unk, 1000, 'absent alang = unknown rank');
  assert.strictEqual(langRank({ alang: 'none' }, prefs), 1000, "'none' = unknown rank");
  assert.strictEqual(langRank({ alang: '' }, prefs), 1000, "'' = unknown rank");
  assert.strictEqual(langRank({ alang: 'und' }, prefs), 1000, "'und' = unknown rank");
  assert.ok(0 < unk && unk < 2000, 'ordering: preferred < unknown < non-preferred');
  // no preference -> nothing is a preferred candidate, only unknown/non-pref tiers
  assert.strictEqual(langRank({ alang: 'en' }, []), 2000, 'no prefs: known = non-pref tier');
  // THE FIX: real yt-dlp uses the field `language`, not `alang`.
  assert.strictEqual(langRank({ language: 'en' }, ['en']), 0, 'REAL field `language` matches preference');
  assert.strictEqual(langRank({ language: 'en-US' }, ['en']), 0, 'subtag `en-US` matches `en`');
  assert.strictEqual(langRank({ language: 'ar' }, ['en']), 2000, 'REAL field `language` non-pref');
  assert.ok(langRank({ language: 'en' }, ['en']) < langRank({ language: 'ar' }, ['en']), 'real-language ordering');
  assert.strictEqual(langRank({}, ['en']), 1000, 'absent language = unknown rank');
});

test('compareAVFormats: preferred language beats height, but within a language vcodec/height still order (video regression guard)', () => {
  const { compareAVFormats } = require('../src/streambot/sources');
  // Same language: the vcodec rank must dominate (h264 beats h265) even if the
  // h265 is much larger.
  const sameLangA = { alang: 'en', vcodec: 'h265', height: 2160, tbr: 5000 };
  const sameLangB = { alang: 'en', vcodec: 'h264', height: 1080, tbr: 4000 };
  assert.ok(
    compareAVFormats(sameLangB, sameLangA, ['en']) < 0,
    'within a language, the better vcodec (h264) must win over weaker (h265)'
  );
  // Same language + same codec: higher height wins.
  const hiHeight = { alang: 'en', vcodec: 'h264', height: 1080 };
  const loHeight = { alang: 'en', vcodec: 'h264', height: 720 };
  assert.ok(compareAVFormats(hiHeight, loHeight, ['en']) < 0, 'same codec: higher height wins');
  // Cross-language: the preferred-language track wins despite lower height/bitrate.
  const preferredLow = { alang: 'en', vcodec: 'h264', height: 480, tbr: 500 };
  const foreignHigh = { alang: 'ar', vcodec: 'h264', height: 2160, tbr: 9000 };
  assert.ok(
    compareAVFormats(preferredLow, foreignHigh, ['en']) < 0,
    'preferred language must beat a higher-bitrate/height foreign dub'
  );
});

test('resolveYtdlp combined A+V (bestManifest): audioLang=[en] picks the English manifest over the higher-bitrate Arabic dub', async () => {
  setScenario('hlsMulti');
  const before = readFakeLog().length;
  const cfg = { ...CfgPlain, audioLang: ['en'] };
  const res = await resolveYtdlp('https://www.youtube.com/watch?v=COMBINED', cfg);
  assert.strictEqual(res.kind, 'ytdlp');
  assert.strictEqual(res.available, true);
  assert.strictEqual(res.streamType, 'single');
  // The English manifest (tbr 1000) must beat the higher-bitrate Arabic (tbr 3000).
  assert.strictEqual(res.streamUrl, 'https://manifest.example/hls/master.m3u8');
  const calls = fakeCalls().slice(before);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].mode, 'dump');
  assert.ok(!calls.some((c) => c.argv.includes('-o')), 'combined A+V must stream the manifest, never download');
});

test('resolveYtdlp combined A+V (bestManifest): audioLang=[] -> original/default manifest (language_preference 0) beats the higher-bitrate foreign dub', async () => {
  setScenario('hlsMulti');
  const cfg = { ...CfgPlain, audioLang: [] };
  const res = await resolveYtdlp('https://www.youtube.com/watch?v=COMBINED', cfg);
  assert.strictEqual(res.available, true);
  assert.strictEqual(res.streamType, 'single');
  // No code preference: both are known languages, so the lower language_preference
  // (0 = original/default, the `master.m3u8` en track) wins over the Arabic dub.
  assert.strictEqual(res.streamUrl, 'https://manifest.example/hls/master.m3u8');
});

// ============================================================================
// 8c) config: audioLang default + SBOT_AUDIO_LANG parsing
// ============================================================================
test('config: loadConfig returns audioLang === [en] by default', () => {
  const old = process.env.SELF_BOT_TOKEN;
  const oldLang = process.env.SBOT_AUDIO_LANG;
  process.env.SELF_BOT_TOKEN = 'test';
  try {
    delete process.env.SBOT_AUDIO_LANG;
    delete require.cache[require.resolve('../src/streambot/config')];
    const cfg = require('../src/streambot/config').loadConfig();
    assert.deepStrictEqual(cfg.audioLang, ['en'], 'default audioLang must be [en]');
  } finally {
    if (old === undefined) delete process.env.SELF_BOT_TOKEN; else process.env.SELF_BOT_TOKEN = old;
    if (oldLang === undefined) delete process.env.SBOT_AUDIO_LANG; else process.env.SBOT_AUDIO_LANG = oldLang;
    delete require.cache[require.resolve('../src/streambot/config')];
  }
});

test('config: SBOT_AUDIO_LANG="en,es" -> [en,es] and SBOT_AUDIO_LANG="" -> []', () => {
  const old = process.env.SELF_BOT_TOKEN;
  const oldLang = process.env.SBOT_AUDIO_LANG;
  process.env.SELF_BOT_TOKEN = 'test';
  try {
    delete require.cache[require.resolve('../src/streambot/config')];
    process.env.SBOT_AUDIO_LANG = 'en,es';
    let cfg = require('../src/streambot/config').loadConfig();
    assert.deepStrictEqual(cfg.audioLang, ['en', 'es'], 'comma list parsed in order, trimmed, lowercased');

    delete require.cache[require.resolve('../src/streambot/config')];
    process.env.SBOT_AUDIO_LANG = ' EN ,  ES ';
    cfg = require('../src/streambot/config').loadConfig();
    assert.deepStrictEqual(cfg.audioLang, ['en', 'es'], 'padding/whitespace trimmed and lowercased');

    delete require.cache[require.resolve('../src/streambot/config')];
    process.env.SBOT_AUDIO_LANG = '';
    cfg = require('../src/streambot/config').loadConfig();
    assert.deepStrictEqual(cfg.audioLang, [], 'empty string = no preference');
  } finally {
    if (old === undefined) delete process.env.SELF_BOT_TOKEN; else process.env.SELF_BOT_TOKEN = old;
    if (oldLang === undefined) delete process.env.SBOT_AUDIO_LANG; else process.env.SBOT_AUDIO_LANG = oldLang;
    delete require.cache[require.resolve('../src/streambot/config')];
  }
});

// ============================================================================
// 8b) parseStartTime: YouTube &t=/st=/start= offsets
// ============================================================================
{
  const { parseStartTime } = require('../src/streambot/sources');
  test('parseStartTime: t=120 -> 120', () => {
    assert.strictEqual(parseStartTime('https://youtube.com/watch?v=x&t=120'), 120);
  });
  test('parseStartTime: t=1h2m3s -> 3723', () => {
    assert.strictEqual(parseStartTime('https://youtube.com/watch?v=x&t=1h2m3s'), 3723);
  });
  test('parseStartTime: st=90s -> 90', () => {
    assert.strictEqual(parseStartTime('https://youtu.be/x?st=90s'), 90);
  });
  test('parseStartTime: t=2m30s -> 150', () => {
    assert.strictEqual(parseStartTime('https://youtube.com/watch?v=x&t=2m30s'), 150);
  });
  test('parseStartTime: no offset param -> null', () => {
    assert.strictEqual(parseStartTime('https://youtube.com/watch?v=x'), null);
  });
  test('parseStartTime: garbage offset -> null', () => {
    assert.strictEqual(parseStartTime('https://youtube.com/watch?v=x&t=garbage'), null);
  });
  test('parseStartTime: t=1h2m -> 3720', () => {
    assert.strictEqual(parseStartTime('https://youtube.com/watch?v=x&t=1h2m'), 3720);
  });
  test('parseStartTime: start=60 -> 60 (lower priority)', () => {
    assert.strictEqual(parseStartTime('https://youtube.com/watch?v=x&start=60'), 60);
  });
}

test('offset end-to-end: hls + &t=123 -> manifest URL with startOffsetSec=123', async () => {
  setScenario('hls');
  const before = readFakeLog().length;
  const res = await resolveYtdlp('https://www.youtube.com/watch?v=x&t=123', CfgPlain);
  assert.strictEqual(res.available, true);
  assert.strictEqual(res.streamUrl, 'https://manifest.example/hls/master.m3u8');
  assert.strictEqual(res.startOffsetSec, 123);
  const calls = fakeCalls().slice(before);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].mode, 'dump');
});

test('offset end-to-end: dash + &t=60 -> startOffsetSec=60 propagated', async () => {
  setScenario('dash');
  const res = await resolveYtdlp('https://www.youtube.com/watch?v=x&t=60', CfgPlain);
  assert.strictEqual(res.available, true);
  assert.strictEqual(res.streamType, 'dash');
  assert.strictEqual(res.startOffsetSec, 60);
});

// ============================================================================
// 9) streamManager: setupStreamOptions / shared Streamer / playStream watchdog
//    (heavy ESM deps are stubbed; no network, no real ffmpeg)
// ============================================================================
test('streamManager: setupStreamOptions has minimizeLatency=false and fixed session width', async () => {
  const { StreamManager } = require('../src/streambot/streamManager');
  const mod = { Utils: { normalizeVideoCodec: (c) => c } };
  const mgr = new StreamManager({ on() {} }, 'ch1', {
    videoCodec: 'H264',
    streamBitrate: 5000,
    streamHeight: 1080,
    streamFrameRate: 30,
    hardwareAccel: false
  });
  const opts = mgr.setupStreamOptions(mod);
  assert.strictEqual(opts.minimizeLatency, false, 'minimizeLatency must be false (reference behavior)');
  assert.strictEqual(opts.width, 1920, 'one fixed width across every piece; aspect ratio preserved by padding');
  assert.strictEqual(opts.height, 1080);
  assert.strictEqual(opts.h26xPreset, 'ultrafast', 'h26xPreset must match reference');
  assert.strictEqual(opts.includeAudio, true);
});

test('streamManager: setupStreamOptions startOffsetSec -> customInputOptions [-ss, N]', () => {
  const { StreamManager } = require('../src/streambot/streamManager');
  const mod = { Utils: { normalizeVideoCodec: (c) => c } };
  const mgr = new StreamManager({ on() {} }, 'ch1', {
    videoCodec: 'H264',
    streamBitrate: 5000,
    streamHeight: 1080,
    streamFrameRate: 30,
    hardwareAccel: false
  });
  const withOffset = mgr.setupStreamOptions(mod, 123);
  assert.deepStrictEqual(
    withOffset.customInputOptions,
    ['-ss', '123'],
    'a numeric startOffsetSec must translate to the ffmpeg input-seek option'
  );

  const noOffset = mgr.setupStreamOptions(mod);
  assert.ok(
    !Array.isArray(noOffset.customInputOptions) || noOffset.customInputOptions.length === 0,
    'without an offset, customInputOptions must be unset or empty (behavior unchanged)'
  );
});

test('streamManager: consecutive start() calls reuse one shared Streamer', async () => {
  const { StreamManager } = require('../src/streambot/streamManager');

  const mkVoiceConn = () => ({
    webRtcConn: { mediaConnection: { webRtcParams: null, start() {} } },
    status: { hasSession: true, hasToken: true, started: true },
    streamConnection: { serverId: 'srv', webRtcConn: { ready: true } },
    voiceConnection: { streamConnection: null, guildId: 'g1', channelId: 'c1', botId: 'u1' }
  });

  const mkModule = (streamerImpl) => ({
    Streamer: streamerImpl,
    prepareStream: () => ({
      // Well-formed result; the hang happens in playStream's createStream()
      // wait (gateway opcodes never acked), so these look normal.
      command: { on() { }, getCommand: () => ['ffmpeg', '-i', 'input', 'out'] },
      output: { on() { } },
      promise: new Promise(() => { }),
      controller: null
    }),
    playStream: () => new Promise(() => { }),
    Utils: { normalizeVideoCodec: (c) => c }
  });

  // Shared streamer stub: camera mode has NO go-live handshake (the old
  // watchdog-trip scenario is gone), so joinVoice succeeds and both start()
  // calls are OK. The point of this test is that one Streamer instance is
  // REUSED across consecutive start() calls (no listener leak).
  let instances = 0;
  const streamerStub = {
    joined: false,
    voiceConnection: undefined,
    joinVoice: async function () {
      this.joined = true;
      // Mirror the real library (Streamer.js): every joinVoice REPLACES the
      // stored connection with a fresh one.
      this.voiceConnection = undefined;
      this.voiceConnection = mkVoiceConn();
      return { mediaConnection: { webRtcParams: null, start() {} } };
    },
    stopStream() { },
    leaveVoice() { },
    signalVideo(v) { }
  };
  const Streamer = function () {
    instances += 1;
    return streamerStub;
  };

  const mkManager = () => {
    const client = { token: 't', channels: { cache: { get: () => ({ id: 'c1' }) }, fetch: async () => ({ id: 'c1' }) } };
    const mgr = new StreamManager(client, 'c1', {
      videoCodec: 'H264', streamBitrate: 5000, streamHeight: 1080,
      streamFrameRate: 30, hardwareAccel: false,
      playStreamStartTimeoutMs: 200
    });
    mgr._feederFactory = () => ({ start: async () => ({}), append: async () => {}, interrupt: () => {}, close: async () => {} });
  mgr._prepareSingle = (vm, piece) => vm.prepareStream(piece.streamUrl, mgr.setupStreamOptions(vm, piece.startOffsetSec, piece.durationSec, piece.inputFormat), piece.control.signal);
  mgr._videoModule = mkModule(Streamer);
    return mgr;
  };

  const mgr1 = mkManager();
  const r1 = await mgr1.start({ guildId: 'g1', channelId: 'c1', streamUrl: 'https://example.com/x.mp4' });
  assert.strictEqual(r1.ok, true, 'go-live start succeeds on the acknowledged connection');
  assert.strictEqual(instances, 1, 'first start() must construct exactly one Streamer');
  assert.strictEqual(mgr1.session, r1.session, 'a session must be attached');

  // Same manager, second start on the SAME channel: reuses the voice link and
  // the shared Streamer — it must NOT build a new Streamer.
  const mgr2 = mgr1;
  const r2 = await mgr2.start({ guildId: 'g1', channelId: 'c1', streamUrl: 'https://example.com/y.mp4' });
  assert.strictEqual(r2.ok, true, 'second start() must succeed over the persistent session');
  assert.strictEqual(instances, 1, 'second start() must reuse the shared Streamer (no listener leak)');
  assert.strictEqual(r2.session.streamer, r1.session.streamer, 'both sessions must attach to the SAME streamer instance');
});

test('streamManager: dash start() rejects non-http videoUrl/audioUrl BEFORE channel work', async () => {
  const { StreamManager } = require('../src/streambot/streamManager');
  const client = { token: 't', channels: { cache: { get: () => ({ id: 'c1' }) }, fetch: async () => ({ id: 'c1' }) } };
  const mgr = new StreamManager(client, 'c1', { videoCodec: 'H264' });
  const r1 = await mgr.start({ guildId: 'g1', channelId: 'c1', videoUrl: 'file:///tmp/v.mp4', audioUrl: 'https://example.com/a.m4a' });
  assert.strictEqual(r1.ok, false, 'non-http videoUrl must be rejected');
  const r2 = await mgr.start({ guildId: 'g1', channelId: 'c1', videoUrl: 'https://example.com/v.mp4', audioUrl: 'not a url' });
  assert.strictEqual(r2.ok, false, 'non-http audioUrl must be rejected');
  const r3 = await mgr.start({ guildId: 'g1', channelId: 'c1' });
  assert.strictEqual(r3.ok, false, 'missing all inputs must be rejected');
});

// ============================================================================
// 10) webhook: channelId/guildId validated BEFORE resolveSource (no yt-dlp spawn)
// ============================================================================
test('webhook: missing channel_id -> 400 and yt-dlp is NOT invoked', async () => {
  const crypto = require('crypto');
  const { createWebhookServer } = require('../src/streambot/webhookServer');

  setScenario('dash'); // if resolveSource ran, it would now spawn yt-dlp
  const before = readFakeLog().length;

  const secret = 'wh-secret';
  const fakeSources = {
    resolveSource: async () => {
      throw new Error('resolveSource must NOT be reached for a channel-less request');
    }
  };
  const sm = { status: () => null };
  const server = createWebhookServer({
    config: { webhookSecret: secret, streamChannelId: null, guildId: null, token: 't' },
    streamManager: sm,
    sources: fakeSources
  });

  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  try {
    const body = JSON.stringify({ stream_url: 'https://www.youtube.com/watch?v=WHTEST' });
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const res = await fetch(`http://127.0.0.1:${port}/webhook/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': sig },
      body
    });
    assert.strictEqual(res.status, 400, 'channel-less request must be 400, not resolved');
    const calls = readFakeLog().length;
    assert.strictEqual(calls, before, 'yt-dlp must not be spawned when the channel is missing');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('webhook: preserves live classification and duration metadata from source resolution', async () => {
  const crypto = require('crypto');
  const { createWebhookServer } = require('../src/streambot/webhookServer');
  const secret = 'wh-live-secret';
  let started;
  const server = createWebhookServer({
    config: { webhookSecret: secret, streamChannelId: 'c1', guildId: 'g1', token: 't' },
    streamManager: {
      status: () => null,
      start: async (args) => { started = args; return { ok: true }; }
    },
    sources: {
      resolveSource: async () => ({
        kind: 'sharetv', available: true, streamUrl: 'https://tv.example/live',
        isLive: true, totalDurationSec: null
      })
    }
  });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  try {
    const body = JSON.stringify({ share_slug: 'live-test' });
    const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
    const res = await fetch(`http://127.0.0.1:${port}/webhook/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': sig },
      body
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(started.isLive, true);
    assert.strictEqual(started.totalDurationSec, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ============================================================================
// 11) VOD media-EOF close-race: fluent-ffmpeg emits 'error' with
//     "Output stream closed" (processor.js emitEnd on output close), which
//     IS a clean completion, not a failure. The bot must:
//       * not log it as an error,
//       * resolve (not reject) the dash-merge promise,
//       * send the user-facing "video finished" message exactly ONCE even
//         if playStream's .then also fires,
//       * still tear down,
//     while any OTHER ffmpeg 'error' keeps the old error behavior.
// ============================================================================
test('isBenignEnd: exact fluent-ffmpeg close-race string -> true; anything else -> false', () => {
  assert.strictEqual(isBenignEnd(new Error('Output stream closed')), true);
  assert.strictEqual(isBenignEnd({ message: 'Output stream closed' }), true);
  assert.strictEqual(isBenignEnd(new Error('Output stream error: ECONNRESET')), false);
  assert.strictEqual(isBenignEnd(new Error('No such file or directory')), false);
  assert.strictEqual(isBenignEnd(new Error('output stream closed')), false, 'case-sensitive exact match');
  assert.strictEqual(isBenignEnd(null), false);
  assert.strictEqual(isBenignEnd(undefined), false);
  assert.strictEqual(isBenignEnd({}), false);
  assert.strictEqual(isBenignEnd('Output stream closed'), false, 'must be an object with .message');
});

// Shared helpers -----------------------------------------------------------
// Fake fluent-ffmpeg command: records 'error'/'end' listeners, exposes emitError().
function makeFakeCommand(captured) {
  const listeners = { error: [], end: [] };
  const command = {
    listeners,
    on(ev, cb) { (listeners[ev] || (listeners[ev] = [])).push(cb); return command; },
    kill(sig) { captured.push(`command.kill(${sig})`); },
    process: null
  };
  return command;
}

// Fake @dank074/discord-video-stream module: joinVoice acks immediately,
// playStream promise is RESOLVABLE from the test (the real library may void it
// via its abort guard — that is exactly the case the fallback must cover).
function makeVideoModule(playStreamSettlers) {
  return {
    Streamer: function FakeStreamer(client) {
      this.client = client;
      const self = this;
      this.voiceConnection = { streamConnection: { serverId: 'srv', webRtcConn: { ready: true } } };
      this.joinVoice = async () => ({ mediaConnection: { webRtcParams: null, start() {  } } });
      this.stopStream = function () {};
      this.leaveVoice = function () {};
    },
    prepareStream: (url, opts, signal) => {
      const captured = [];
      const command = makeFakeCommand(captured);
      return {
        command,
        output: { on() { return { on() { } }; }, destroy() { } },
        promise: new Promise(() => {}),
        controller: null,
        __captured: captured
      };
    },
    playStream: () => new Promise((resolve) => { playStreamSettlers.push(resolve); }),
    Utils: { normalizeVideoCodec: (c) => c }
  };
}

function makeStreamManager({ channelSend, playStreamSettlers, title }) {
  const plays = playStreamSettlers || [];
  const channel = {
    id: 'c1',
    sent: [],
    send(text) {
      channel.sent.push(text);
      if (channelSend) return Promise.resolve(channelSend(text));
      return Promise.resolve();
    }
  };
  const alerts = [];
  const sink = { notify: async (event, detail) => { alerts.push({ event, detail }); } };
  const sentLogs = { info: [], error: [] };
  const realLog = console.log;
  const realErr = console.error;
  // NOTE: streamManager.log() spreads its message (console.log(TAG, ...parts)),
  // so the message arrives as per-character arguments — re-join with '' (not a
  // space) to reconstruct the exact string. Match BOTH the legacy "completed
  // cleanly" line and the new reclassified "stream ended: pipe closed" line
  // so the assertion harness keeps working either way.
  console.log = (...parts) => { const j = parts.map((p) => String(p)).join(''); if (/completed cleanly|stream ended: pipe closed/.test(j)) sentLogs.info.push(j); };
  console.error = (...parts) => { const j = parts.map((p) => String(p)).join(''); if (/ffmpeg error|dash merge ffmpeg error/.test(j)) sentLogs.error.push(j); };
  const restore = () => { console.log = realLog; console.error = realErr; };
  const client = { token: 'test-token', channels: { cache: { get: (id) => (id === 'c1' ? channel : null) } } };
  const mgr = new StreamManager(client, 'c1', {
    videoCodec: 'H264', streamBitrate: 5000, streamHeight: 1080,
    streamFrameRate: 30, hardwareAccel: false, playStreamStartTimeoutMs: 50,
    alertSink: sink
  });
  mgr._feederFactory = () => ({
    start: async () => { plays.push(() => {}); return {}; },
    append: async () => {}, interrupt: () => {}, close: async () => {}
  });
  mgr._prepareSingle = (vm, piece) => vm.prepareStream(piece.streamUrl, mgr.setupStreamOptions(vm, piece.startOffsetSec, piece.durationSec, piece.inputFormat), piece.control.signal);
  mgr._videoModule = makeVideoModule(plays);
  const startArgs = { guildId: 'g1', channelId: 'c1', streamUrl: 'https://example.com/finish.mp4' };
  if (title) startArgs.title = title;
  return { mgr, channel, plays, restore, startArgs, sentLogs, alerts };
}

function makeFakeDashResult(settleBehavior) {
  const captured = [];
  const command = makeFakeCommand(captured);
  const output = { on() { return { on() { } }; }, destroy() { } };
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
    command.on('error', (err) => settleBehavior({ resolve: resolvePromise, reject: rejectPromise, err }));
    command.on('end', () => resolvePromise());
  });
  // Match production (_buildDashMerge attaches promise.catch to avoid an
  // unhandled rejection until the caller settles it). assert.rejects() below
  // still observes the real rejection on `promise` itself.
  promise.catch(() => {});
  // Test hook on the command itself (session.command === this object).
  command.__emitError = (e) => (command.listeners.error || []).forEach((cb) => cb(e));
  return {
    command,
    output,
    promise,
    controller: null,
    __captured: captured
  };
}

test('RECLASSIFIED close-race: ffmpeg "Output stream closed" resolves and starts filler on the same session', async () => {
  const t = makeStreamManager({});
  // Mirror the production wiring: ambiguous pipe-close -> RESOLVE (not
  // reject); non-benign -> reject.
  t.mgr._buildDashMerge = (videoModule, videoUrl, audioUrl, startOffsetSec) =>
    makeFakeDashResult(({ resolve, reject, err }) => {
      if (isBenignEnd(err)) { resolve(); return; }
      reject(err);
    });
  const result = await t.mgr.start({ guildId: 'g1', channelId: 'c1', videoUrl: 'https://example.com/v.mp4', audioUrl: 'https://example.com/a.m4a' });
  assert.strictEqual(result.ok, true, 'VOD start must succeed');
  const session = result.session;
  assert.ok(session, 'a live session must exist to tear down');

  // Simulate the observed close-race: demuxer ends, output closes, fluent-ffmpeg
  // emits the ambiguous "Output stream closed" error.
  session.command.__emitError(new Error('Output stream closed'));
  await new Promise((r) => setTimeout(r, 30));

  assert.strictEqual(t.sentLogs.error.length, 0, 'the pipe-close string must NOT be logged at error level');
  assert.ok(
    t.sentLogs.info.some((j) => /stream ended: pipe closed/.test(j)),
    'the new unambiguous INFO line must surface here (replaces the old "completed cleanly" claim)'
  );
  assert.notStrictEqual(t.mgr.session, session, 'ended VOD must be cleared');
  assert.strictEqual(t.mgr.session?.isFiller, true, 'filler follows the terminal VOD');

  await new Promise((resolveAwait, rejectAwait) => {
    const timer = setTimeout(() => rejectAwait(new Error('dash-merge promise must RESOLVE for a clean VOD end, but it stayed pending or rejected')), 100);
    session.promise.then(() => { clearTimeout(timer); resolveAwait(); }, (e) => {
      clearTimeout(timer);
      rejectAwait(new Error('dash-merge promise must RESOLVE (not reject) on the benign close-race error, got rejection: ' + (e && e.message)));
    });
  });
  t.restore();
});

test('non-benign ffmpeg error -> dash-merge promise REJECTS + error log (behavior unchanged)', async () => {
  const t = makeStreamManager({});
  t.mgr._buildDashMerge = (videoModule, videoUrl, audioUrl, startOffsetSec) =>
    makeFakeDashResult(({ resolve, reject, err }) => {
      if (isBenignEnd(err)) { resolve(); return; }
      reject(err);
    });
  const result = await t.mgr.start({ guildId: 'g1', channelId: 'c1', videoUrl: 'https://example.com/v.mp4', audioUrl: 'https://example.com/a.m4a' });
  assert.strictEqual(result.ok, true);
  const session = result.session;

  session.command.__emitError(new Error('No such file or directory'));
  await new Promise((r) => setTimeout(r, 30));

  await assert.rejects(session.promise, /No such file or directory/, 'non-benign error must REJECT the dash-merge promise');
  assert.strictEqual(t.channel.sent.length, 0, 'a real ffmpeg failure must NOT send a "finished" message (no channel send at all)');
  assert.strictEqual(t.alerts.filter((a) => a.event === 'stream-ended').length, 0, 'no stream-ended alert for a genuine failure');
  assert.ok(
    t.alerts.some((a) => a.event === 'stream-error' && /No such file or directory/.test(a.detail)),
    'a genuine ffmpeg failure must raise a stream-error alert'
  );
  t.restore();
});

test('ended channel message sent EXACTLY ONCE even if both error-handler and producer end fire', async () => {
  const t = makeStreamManager({ title: 'My VOD Title' });
  const result = await t.mgr.start(t.startArgs);
  assert.strictEqual(result.ok, true);
  const session = result.session;

  // Error-handler fallback fires first (library voided the playStream promise).
  // The fake command has no child process (no exitCode) -> under the
  // reclassified semantics the pipe-close string IS ambiguous here, so the
  // neutral "stream stopped" message is the expected first send.
  const errorListener = session.command.listeners && session.command.listeners.error;
  assert.ok(errorListener && errorListener.length, 'the command must have an error listener wired');
  errorListener.forEach((cb) => cb(new Error('Output stream closed')));
  await new Promise((r) => setTimeout(r, 25));
  assert.strictEqual(t.channel.sent.length, 0, 'NO channel send — the restricted account must never send');
  assert.strictEqual(t.alerts.filter((a) => a.event === 'stream-ended').length, 1, 'the fallback must alert once');
  assert.strictEqual(t.alerts.filter((a) => a.event === 'stream-ended')[0].detail, M.STREAM_VOD_STOPPED, 'no exitCode -> ambiguous -> neutral message');

  // Then playStream .then also fires: must NOT double-alert (dedup unchanged).
  (t.mgr.session?.command.listeners?.end || []).forEach(resolve => resolve());
  await new Promise((r) => setTimeout(r, 25));
  assert.strictEqual(t.channel.sent.length, 0, 'still no channel send');
  assert.strictEqual(t.alerts.filter((a) => a.event === 'stream-ended').length, 1, 'dedup: .then must NOT re-notify');
  assert.strictEqual(t.mgr.session, null);
  t.restore();
});

test('ended channel message sent exactly once when producer end fires first (no error event at all)', async () => {
  const t = makeStreamManager({ title: 'Clean VOD' });
  const result = await t.mgr.start(t.startArgs);
  assert.strictEqual(result.ok, true);
  const expected = M.STREAM_VOD_ENDED('Clean VOD');
  (t.mgr.session?.command.listeners?.end || []).forEach(resolve => resolve());
  await new Promise((r) => setTimeout(r, 25));
  assert.strictEqual(t.channel.sent.length, 0, 'NO channel send — restricted account');
  const endedAlerts = t.alerts.filter((a) => a.event === 'stream-ended');
  assert.strictEqual(endedAlerts.length, 1, '.then must alert the finished message once');
  assert.strictEqual(endedAlerts[0].detail, expected);
  t.restore();
});

test('ended message falls back to the generic key when no title is set', async () => {
  const t = makeStreamManager({});
  const result = await t.mgr.start(t.startArgs);
  assert.strictEqual(result.ok, true);
  (t.mgr.session?.command.listeners?.end || []).forEach(resolve => resolve());
  await new Promise((r) => setTimeout(r, 25));
  assert.strictEqual(t.channel.sent.length, 0, 'NO channel send');
  const endedAlerts = t.alerts.filter((a) => a.event === 'stream-ended');
  assert.deepStrictEqual(endedAlerts.map((a) => a.detail), [M.STREAM_VOD_ENDED(null)]);
  assert.ok(!/undefined/.test(String(endedAlerts[0].detail)), 'title-less message must not contain the literal "undefined"');
  t.restore();
});

test('missing channel cache -> no send, but no crash and VOD still falls back to filler', async () => {
  const t = makeStreamManager({});
  const result = await t.mgr.start(t.startArgs);
  assert.strictEqual(result.ok, true);
  // Simulate the target channel being evicted from the client cache.
  t.mgr.client.channels.cache.get = () => null;
  (t.mgr.session?.command.listeners?.end || []).forEach(resolve => resolve());
  await new Promise((r) => setTimeout(r, 25));
  assert.strictEqual(t.channel.sent.length, 0, 'no channel send (restricted account, no crash)');
  assert.strictEqual(t.alerts.filter((a) => a.event === 'stream-ended').length, 1, 'the end alert still fires without a cached channel');
  assert.strictEqual(t.mgr.session?.isFiller, true, 'filler must follow the ended VOD');
  t.restore();
});
