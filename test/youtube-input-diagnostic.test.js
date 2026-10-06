'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sanitize, run, inputArgs } = require('../scripts/diagnose-youtube-input.cjs');

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
