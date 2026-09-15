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
// Scenario-driven. The fake binary reads a SCENARIO file (default: "single").
// It behaves like the real `yt-dlp`:
//   * `-g` probe   -> prints ONE URL PER LINE on stdout:
//                       single : 1 combined-stream URL
//                       dash   : 2 URLs (best-video line, then best-audio line)
//     (This is what resolves the YouTube-DASH bug: a multi-line -g means DASH
//     and must be downloaded + merged, NOT streamed line-by-line.)
//   * `-o <tmpl>`  -> "download": writes a merged media file at <tmpl>.webm
//     and prints the file path (as real yt-dlp does), exit 0.
// It also appends each argv to a sidecar log so tests can assert exactly how
// yt-dlp was invoked (which mode, which URL, how many times) without the network.
let FAKE_BIN;
let FAKE_LOG;
let FAKE_DIR;
let FAKE_SCENARIO;
let FAKE_SIZE;

// Shared config for tests. ytdlpPath is set in before() (FAKE_BIN not known yet).
const CfgPlain = {
  shareTvBase: 'http://localhost:8080',
  shareTvAllowHosts: [],
  ytdlpPath: 'yt-dlp',
  ytdlpFormat: 'bv*+ba/b',
  ytdlpTimeoutMs: 20000,
  ytdlpDownloadFormat: 'bv*[height<=720]+ba/b[height<=720]/b',
  ytdlpDownloadTimeoutMs: 300000,
  token: 'test-token'
};

before(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-fake-'));
  FAKE_BIN = path.join(dir, 'ytdlp-fake');
  FAKE_DIR = dir;
  FAKE_LOG = path.join(dir, 'argv.log');
  FAKE_SCENARIO = path.join(dir, 'scenario');
  FAKE_SIZE = path.join(dir, 'size');
  fs.writeFileSync(FAKE_BIN, shebangScript());
  fs.chmodSync(FAKE_BIN, 0o755);
  setScenario('single');
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

// Switch the fake-yt-dlp behavior. "single" = one combined stream URL on -g;
// "dash" = two separate URLs on -g (DASH: must be downloaded + merged).
function setScenario(name) {
  fs.writeFileSync(FAKE_SCENARIO, String(name));
  return name;
}

function shebangScript() {
  const out = [];
  out.push('#!/usr/bin/env node');
  out.push("const fs = require('fs');");
  out.push(`const argv = process.argv.slice(2);`);
  out.push(`const LOG = ${JSON.stringify(FAKE_LOG)};`);
  out.push(`const SC = ${JSON.stringify(FAKE_SCENARIO)};`);
  out.push(`const SIZE = ${JSON.stringify(FAKE_SIZE)};`);
  out.push(`const SINGLE = 'https://cdn.example/fake/combined.mp4';`);
  out.push(`const V = 'https://cdn.example/fake/dash-video.webm';`);
  out.push(`const A = 'https://cdn.example/fake/dash-audio.webm';`);
  out.push(`try { fs.appendFileSync(LOG, JSON.stringify({ argv }) + '\\n'); } catch {}`);
  out.push('let scenario = \'single\';');
  out.push('try { scenario = (fs.readFileSync(SC, \'utf8\').trim() || \'single\'); } catch {}');
  out.push('const i = argv.indexOf(\'-g\');');
  out.push('if (i !== -1) {');
  out.push('  // probe: emit the playable URL(s), one per line. Real yt-dlp -g does exactly');
  out.push('  // this: single stream -> one line; DASH -> best-video line + best-audio line.');
  out.push('  if (scenario === \'dash\') process.stdout.write(V + \'\\n\' + A + \'\\n\');');
  out.push('  else process.stdout.write(SINGLE + \'\\n\');');
  out.push('  process.exit(0);');
  out.push('}');
  out.push('const o = argv.indexOf(\'-o\');');
  out.push('if (o !== -1 && argv[o + 1]) {');
  out.push('  // download + merge: write a media file at <template>.webm, print its path.');
  out.push('  const p = argv[o + 1] + \'.webm\';');
  out.push('  let body = Buffer.from(\'fake-media\');');
  out.push('  let sizeBytes = 0;');
  out.push('  try { sizeBytes = parseInt(fs.readFileSync(SIZE, \'utf8\').trim(), 10) || 0; } catch {}');
  out.push('  if (sizeBytes > 0) body = Buffer.allocUnsafe(sizeBytes);');
  out.push('  try { fs.writeFileSync(p, body); } catch {}');
  out.push('  process.stdout.write(p + \'\\n\');');
  out.push('  process.exit(0);');
  out.push('}');
  out.push('process.stderr.write(\'fake yt-dlp: unknown invocation\\n\');');
  out.push('process.exit(1);');
  return out.join('\n') + '\n';
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

// Classify each recorded yt-dlp invocation: "probe" (-g) or "download" (-o).
function fakeCalls() {
  return readFakeLog().map((e) => ({
    argv: e.argv,
    mode: e.argv.includes('-g') ? 'probe' : e.argv.includes('-o') ? 'download' : 'unknown',
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

test('selection: media_url present -> media_url chosen and yt-dlp IS invoked (single stream)', async () => {
  setScenario('single'); // Twitch single combined stream: one -g probe, no download
  const before_calls = readFakeLog().length;
  await withShare(SHARE_PLATFORM, async () => {
    const res = await resolveSource('tw-test', CfgPlain);
    assert.strictEqual(res.kind, 'sharetv');
    assert.strictEqual(res.available, true);
    assert.strictEqual(res.streamUrl, 'https://cdn.example/fake/combined.mp4');
    assert.strictEqual(res.localFile, false, 'single stream must be a direct URL, not a local file');
    assert.strictEqual(res.localDir, null);
  });
  const calls = fakeCalls().slice(before_calls);
  assert.strictEqual(calls.length, 1, 'exactly one yt-dlp call (a -g probe, no download) for a single platform stream');
  assert.strictEqual(calls[0].mode, 'probe');
  assert.strictEqual(calls[0].url, 'https://twitch.tv/example');
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
  setScenario('single');
  const cfg = { ...CfgPlain, ytdlpPath: '/nonexistent/yt-dlp' };
  const res = await resolveDirect('https://twitch.tv/foo'); // confirm direct rejects
  assert.strictEqual(res, null);
  const ytdlp = await Promise.resolve(resolveYtdlp('https://twitch.tv/foo', cfg));
  assert.strictEqual(ytdlp.available, false);
  assert.match(ytdlp.note, /yt-dlp/i);
});

// ============================================================================
// 7) DASH — the real YouTube-VOD bug. YouTube VODs serve DASH: `yt-dlp -g`
//    prints best-video + best-audio on separate lines. The OLD code grabbed the
//    last line (audio-only) and streamed no picture. Correct behavior: probe via
//    -g detects >1 URL (DASH) -> download + merge to a local file -> stream the
//    local path. A single-URL -g (live / combined A+V) streams the URL directly.
// ============================================================================
test('DASH: multi-URL -g -> download+merge, stream the local file (not a URL)', async () => {
  setScenario('dash');
  const before = readFakeLog().length;
  const url = 'https://www.youtube.com/watch?v=HRp_7Wfu4MY';
  const res = await resolveYtdlp(url, CfgPlain);
  const dir = res.localDir;
  try {
    assert.strictEqual(res.kind, 'ytdlp');
    assert.strictEqual(res.available, true);
    assert.strictEqual(res.localFile, true, 'DASH must produce a local file');
    assert.ok(res.streamUrl.startsWith('/'), 'DASH streamUrl must be an absolute local path, not http');
    assert.ok(fs.existsSync(res.streamUrl), 'merged file must exist on disk');
    assert.ok(res.localDir, 'localDir must be set so the manager can clean up');
    assert.ok(fs.existsSync(res.localDir), 'localDir must exist');

    const calls = fakeCalls().slice(before);
    assert.strictEqual(calls.length, 2, 'DASH must invoke yt-dlp twice: -g probe then -o download');
    assert.strictEqual(calls[0].mode, 'probe');
    assert.strictEqual(calls[1].mode, 'download');
    assert.strictEqual(calls[0].url, url);
    assert.strictEqual(calls[1].url, url);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
  }
});

test('DASH regression: must NOT take the audio-only line as the stream', async () => {
  setScenario('dash');
  const res = await resolveYtdlp('https://www.youtube.com/watch?v=DASHBUG', CfgPlain);
  const dir = res.localDir;
  try {
    assert.strictEqual(res.available, true);
    assert.strictEqual(res.localFile, true, 'DASH must be downloaded, never streamed as the audio URL');
    assert.notStrictEqual(res.streamUrl, 'https://cdn.example/fake/dash-audio.webm', 'the audio-only DASH line must never be the stream');
    assert.ok(!/^https?:\/\//.test(res.streamUrl), 'DASH must be a local path, never a remote URL');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
  }
});

test('single: one-URL -g -> stream the URL directly (no download)', async () => {
  setScenario('single');
  const before = readFakeLog().length;
  const res = await resolveYtdlp('https://twitch.tv/somestreamer', CfgPlain);
  assert.strictEqual(res.kind, 'ytdlp');
  assert.strictEqual(res.available, true);
  assert.strictEqual(res.streamUrl, 'https://cdn.example/fake/combined.mp4');
  assert.strictEqual(res.localFile, false, 'single stream must be a direct remote URL');
  assert.strictEqual(res.localDir, null);

  const calls = fakeCalls().slice(before);
  assert.strictEqual(calls.length, 1, 'single stream: only a -g probe, no download');
  assert.strictEqual(calls[0].mode, 'probe');
});

test('DASH via ShareTV platform share -> localFile/localDir propagate', async () => {
  setScenario('dash');
  let res;
  await withShare(SHARE_PLATFORM, async () => {
    res = await resolveSource('tw-test', CfgPlain);
    const dir = res.localDir;
    try {
      assert.strictEqual(res.kind, 'sharetv');
      assert.strictEqual(res.available, true);
      assert.strictEqual(res.localFile, true, 'a DASH platform share must flag localFile');
      assert.ok(res.localDir, 'a DASH platform share must propagate localDir for cleanup');
      assert.ok(fs.existsSync(res.streamUrl), 'the merged local file must exist');
      assert.ok(!/^https?:\/\//.test(res.streamUrl), 'a DASH platform share must stream a local path');
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
    }
  });
});

// ============================================================================
// 8) maxStreamSizeMb guard: oversized downloads are deleted and rejected
// ============================================================================
test('maxStreamSizeMb: oversized download -> available:false, note ~size, file cleaned', async () => {
  setScenario('dash');
  fs.writeFileSync(FAKE_SIZE, String(5 * 1024 * 1024)); // 5MB fake media file
  try {
    const cfg = { ...CfgPlain, maxStreamSizeMb: 1 };
    const res = await resolveYtdlp('https://www.youtube.com/watch?v=TOOBIG', cfg);
    assert.strictEqual(res.kind, 'ytdlp');
    assert.strictEqual(res.available, false, 'oversized download must be rejected');
    assert.match(res.note, /size/i, 'note must mention the size limit');
    assert.match(res.note, /STREAMBOT_MAX_STREAM_SIZE_MB=1/);
    assert.ok(!res.localDir, 'localDir must not be exposed when rejected');
  } finally {
    try { fs.rmSync(FAKE_SIZE, { force: true }); } catch { }
  }
});

test('maxStreamSizeMb: size within limit passes (regression)', async () => {
  setScenario('dash');
  fs.writeFileSync(FAKE_SIZE, String(500 * 1024)); // 0.5MB < 1MB
  try {
    const cfg = { ...CfgPlain, maxStreamSizeMb: 1 };
    const res = await resolveYtdlp('https://www.youtube.com/watch?v=OKSIZE', cfg);
    const dir = res.localDir;
    try {
      assert.strictEqual(res.available, true);
      assert.strictEqual(res.localFile, true);
      assert.ok(fs.existsSync(res.streamUrl));
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { }
    }
  } finally {
    try { fs.rmSync(FAKE_SIZE, { force: true }); } catch { }
  }
});

// ============================================================================
// 9) streamManager: setupStreamOptions / shared Streamer / playStream watchdog
//    (heavy ESM deps are stubbed; no network, no real ffmpeg)
// ============================================================================
test('streamManager: setupStreamOptions has minimizeLatency=false and auto width', async () => {
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
  assert.strictEqual(opts.width, -2, 'width must be -2 (aspect-ratio auto per library convention)');
  assert.strictEqual(opts.height, 1080);
  assert.strictEqual(opts.h26xPreset, 'ultrafast', 'h26xPreset must match reference');
  assert.strictEqual(opts.includeAudio, true);
});

test('streamManager: consecutive start() calls reuse one shared Streamer', async () => {
  const { StreamManager } = require('../src/streambot/streamManager');

  const mkVoiceConn = () => ({
    webRtcConn: { mediaConnection: { webRtcParams: null, start() {} } },
    status: { hasSession: true, hasToken: true, started: true },
    streamConnection: null,
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

  // Shared streamer stub: joinVoice succeeds but the go-live handshake
  // (STREAM_CREATE ack) never arrives -> watchdog must trip.
  let instances = 0;
  const streamerStub = {
    joined: false,
    voiceConnection: undefined,
    joinVoice: async function () {
      this.joined = true;
      this.voiceConnection = mkVoiceConn();
      return { mediaConnection: { webRtcParams: null, start() {} } };
    },
    stopStream() { },
    leaveVoice() { }
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
    mgr._videoModule = mkModule(Streamer);
    return mgr;
  };

  const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-hang-'));

  const mgr1 = mkManager();
  const r1 = await mgr1.start({ guildId: 'g1', channelId: 'c1', streamUrl: 'https://example.com/x.mp4', localDir });
  assert.strictEqual(r1.ok, false, 'hang must fail the start');
  assert.match(r1.message, /did not start/i, 'hang message must mention the start failure');
  assert.ok(!fs.existsSync(localDir), 'localDir must be cleaned after the hang');
  assert.strictEqual(instances, 1, 'first start() must construct exactly one Streamer');
  assert.strictEqual(mgr1.session, null, 'session must be cleared after hang teardown');

  // Same manager, second start: must NOT build a new Streamer.
  const mgr2 = mgr1;
  const localDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-hang2-'));
  await mgr2.start({ guildId: 'g1', channelId: 'c1', streamUrl: 'https://example.com/y.mp4', localDir: localDir2 });
  assert.strictEqual(instances, 1, 'second start() must reuse the shared Streamer (no listener leak)');
  assert.ok(!fs.existsSync(localDir2), 'second hang must also clean its localDir');
});

// ============================================================================
// 10) webhook: channelId/guildId validated BEFORE resolveSource (no yt-dlp spawn)
// ============================================================================
test('webhook: missing channel_id -> 400 and yt-dlp is NOT invoked', async () => {
  const crypto = require('crypto');
  const { createWebhookServer } = require('../src/streambot/webhookServer');
  const { EventEmitter } = require('events');

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
