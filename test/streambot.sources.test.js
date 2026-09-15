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

// ---- Fake yt-dlp binary ------------------------------------------------------
// Captures argv to a sidecar file, prints a canned media URL. Lets us assert
// whether yt-dlp was invoked (or not) and with what URL, without hitting the network.
let FAKE_BIN;
let FAKE_LOG;

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
  FAKE_LOG = path.join(dir, 'argv.log');
  fs.writeFileSync(FAKE_BIN, shebangScript());
  fs.chmodSync(FAKE_BIN, 0o755);
  // CfgPlain is defined at module load (before FAKE_BIN exists); point it at the
  // real fake binary now. Use a getter so it always resolves to the live path.
  CfgPlain.ytdlpPath = FAKE_BIN;
});
after(() => {
  // best-effort cleanup of the temp dir
  try {
    const dir = path.dirname(FAKE_BIN);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

function shebangScript() {
  return [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    "const { appendFileSync } = require('fs');",
    'const argv = process.argv.slice(2);',
    `const LOG = ${JSON.stringify(FAKE_LOG)};`,
    'appendFileSync(LOG, JSON.stringify({ argv }) + "\\n");',
    "process.stdout.write('https://cdn.example/fake/video.mp4,https://cdn.example/fake/audio.m4a\\n');",
    ''
  ].join('\n');
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
// 1) Selection order: media_url || hls_url || stream_url
// ============================================================================
test('selection: absent media_url -> hls_url chosen (no yt-dlp)', async () => {
  await withShare(SHARE_ORDINARY, async () => {
    const res = await resolveSource(SLUG, CfgPlain);
    assert.strictEqual(res.kind, 'sharetv');
    assert.strictEqual(res.available, true);
    assert.strictEqual(
      res.streamUrl,
      SIGNED_HLS,
      'must pick hls_url (signed, with ?hls=1) before stream_url'
    );
  });
  const log = readFakeLog();
  assert.strictEqual(log.length, 0, 'yt-dlp must NOT be invoked for ordinary share');
});

test('selection: media_url present -> media_url chosen and yt-dlp IS invoked', async () => {
  const before_calls = readFakeLog().length;
  await withShare(SHARE_PLATFORM, async () => {
    const res = await resolveSource('tw-test', CfgPlain);
    assert.strictEqual(res.kind, 'sharetv');
    assert.strictEqual(res.available, true);
    assert.strictEqual(res.streamUrl, 'https://cdn.example/fake/audio.m4a');
  });
  const log = readFakeLog();
  assert.strictEqual(log.length, before_calls + 1, 'exactly one yt-dlp call for platform share');
  const calledUrl = log[log.length - 1].argv.filter((a) => /^https?:\/\//.test(a))[0];
  assert.strictEqual(calledUrl, 'https://twitch.tv/example');
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
    assert.strictEqual(u.searchParams.get('viewer'), 'AAAA');
    assert.strictEqual(u.searchParams.get('vsig'), 'BBBB');
    assert.strictEqual(u.searchParams.get('hls'), '1');
    // exact raw string is preserved — no parameter reordering or dropping.
    assert.strictEqual(res.streamUrl, SIGNED_HLS);
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
});

test('resolveDirect: accepts signed stream URL (u/sig)', () => {
  const signed = `${BASE}/api/public/stream/x?u=abc&sig=xyz`;
  const res = resolveDirect(signed);
  assert.ok(res);
  assert.strictEqual(res.streamUrl, signed);
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
      `${BASE}/api/public/stream/rel?viewer=R1&vsig=R2&hls=1`,
      'relative hls_url must be resolved against IPTV_SHARE_BASE'
    );
  });
});

test('absolute hls_url passes through unchanged (contract: "absolute playback URLs")', async () => {
  await withShare(SHARE_ORDINARY, async () => {
    const res = await resolveSource(SLUG, CfgPlain);
    assert.ok(res.streamUrl.startsWith('http://'), 'absolute URL must be returned as-is');
    assert.strictEqual(res.streamUrl, SHARE_ORDINARY.hls_url);
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
  const cfg = { ...CfgPlain, ytdlpPath: '/nonexistent/yt-dlp' };
  const res = await resolveDirect('https://twitch.tv/foo'); // confirm direct rejects
  assert.strictEqual(res, null);
  const ytdlp = await Promise.resolve(resolveYtdlp('https://twitch.tv/foo', cfg));
  assert.strictEqual(ytdlp.available, false);
  assert.match(ytdlp.note, /yt-dlp/i);
});
