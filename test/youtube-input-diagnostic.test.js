'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitize, run, inputArgs } = require('../scripts/diagnose-youtube-input.cjs');
const http = require('node:http');
const { spawnSync } = require('node:child_process');

test('source diagnostic output strips signed URLs, headers, and Discord token', () => {
  const text = sanitize('HTTP 403 https://cdn.example/video?sig=SECRET\nCookie: auth=SECRET\n' +
    'Authorization: Bearer SECRET\ntest-token Error opening input', 'test-token');
  assert.match(text, /HTTP 403/);
  assert.match(text, /Error opening input/);
  assert.doesNotMatch(text, /https:\/\/|SECRET|test-token/);
  assert.ok(sanitize('x'.repeat(10000)).length <= 2048);
});

test('source diagnostic kills a stuck input within its configured deadline', async () => {
  const result = await run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 50);
  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
});

test('source diagnostic bounds captured FFmpeg output', async () => {
  const result = await run(process.execPath,
    ['-e', 'process.stderr.write("x".repeat(100000)); process.exitCode = 1;']);
  assert.equal(result.ok, false);
  assert.ok(result.stderr.length <= 8192);
});

test('source diagnostic reads one second without decoding or storing media', () => {
  const args = inputArgs('https://manifest.googlevideo.com/api/manifest/hls_playlist/example.m3u8', {});
  assert.deepEqual(args.slice(-11), ['-t', '1', '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-f', 'null', '-']);
  assert.ok(args.includes('-extension_picky'));
  assert.equal(args[args.indexOf('-rw_timeout') + 1], '15000000');
});

test('source diagnostic matches production reconnect with explicit comparison option', () => {
  const args = inputArgs('https://manifest.googlevideo.com/api/manifest/hls_playlist/itag/301', {});
  assert.ok(args.includes('-extension_picky'));
  assert.ok(args.includes('-reconnect'));
  assert.ok(args.includes('-reconnect_streamed'));
  const comparison = inputArgs('https://manifest.googlevideo.com/api/manifest/hls_playlist/itag/301', {}, { noReconnect: true });
  assert.ok(!comparison.includes('-reconnect'));
  assert.ok(!comparison.includes('-reconnect_streamed'));
  const direct = inputArgs('https://cdn.example/video.mp4', {});
  assert.ok(direct.includes('-reconnect'));
});

test('unknown-length HLS response reaches EOF instead of reopening the manifest', async t => {
  const probe = spawnSync('ffmpeg', ['-version']);
  if (probe.error?.code === 'ENOENT') return t.skip('FFmpeg is unavailable');
  assert.equal(probe.status, 0, String(probe.error || probe.stderr));
  const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=400', '-t', '2', '-c:a', 'aac', '-f', 'adts', 'pipe:1']);
  assert.equal(generated.status, 0, String(generated.stderr));
  const playlist = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n' +
    '#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2,\naudio.aac\n#EXT-X-ENDLIST\n';
  let manifests = 0;
  const server = http.createServer((request, response) => {
    const manifest = request.url === '/manifest';
    if (manifest) manifests++;
    response.useChunkedEncodingByDefault = false;
    response.writeHead(200, { 'Content-Type': manifest ? 'application/vnd.apple.mpegurl' : 'audio/aac',
      'Connection': 'close' });
    // Streaming writes omit Content-Length. Disabling chunked framing gives
    // the valid close-delimited response that exposes FFmpeg's unknown size.
    response.write(manifest ? playlist : generated.stdout);
    response.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const args = inputArgs('https://manifest.googlevideo.com/api/manifest/hls_playlist/itag/234', {}, { noReconnect: true });
  args[args.indexOf('-i') + 1] = `http://127.0.0.1:${server.address().port}/manifest`;
  const fixed = await run('ffmpeg', args, 5000);
  assert.equal(fixed.ok, true, JSON.stringify(fixed));
  assert.equal(manifests, 1);
  const old = [...args];
  old.splice(old.indexOf('-i'), 0, '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  const before = manifests;
  const broken = await run('ffmpeg', old, 2000);
  assert.equal(broken.timedOut, true);
  assert.ok(manifests - before > 1, 'production reconnect options repeatedly reopen this close-delimited fixture');
});
