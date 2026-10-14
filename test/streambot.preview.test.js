'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { uploadStreamPreview } = require('../src/streambot/streamPreview');

async function fixture() {
  const image = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#abc' } }).png().toBuffer();
  const piece = { control: new AbortController(), musicArtwork: { file: image } };
  const uploads = [];
  const pipeline = { ready: Promise.resolve(true), streamer: { setStreamPreview: async jpeg => uploads.push(jpeg) } };
  return { piece, pipeline, uploads, isCurrent: () => true };
}
test('uploads one JPEG still from artwork after Go Live becomes ready', async () => {
  const f = await fixture();
  let ready;
  f.pipeline.ready = new Promise(resolve => { ready = resolve; });
  const task = uploadStreamPreview(f);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.uploads.length, 0);
  ready(true);
  await task;
  assert.equal(f.uploads.length, 1);
  const meta = await sharp(f.uploads[0]).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 512);
  assert.equal(meta.height, 288);
});
test('stopping cancels a pending readiness wait without uploading', async () => {
  const f = await fixture();
  f.pipeline.ready = new Promise(() => {});
  const task = uploadStreamPreview(f);
  f.piece.control.abort();
  await task;
  assert.equal(f.uploads.length, 0);
});
test('superseded piece cannot upload when readiness arrives', async () => {
  const f = await fixture();
  let ready;
  let current = true;
  f.isCurrent = () => current;
  f.pipeline.ready = new Promise(resolve => { ready = resolve; });
  const task = uploadStreamPreview(f);
  current = false;
  ready(true);
  await task;
  assert.equal(f.uploads.length, 0);
});
test('upload rejection is contained and reports only generic failure', async () => {
  const f = await fixture();
  let failures = 0;
  f.onFailure = () => { failures++; };
  f.pipeline.streamer.setStreamPreview = async () => { throw new Error('private URL'); };
  await uploadStreamPreview(f);
  assert.equal(failures, 1);
});
test('missing image and failed Go Live readiness skip preview', async () => {
  const f = await fixture();
  f.piece.musicArtwork = null;
  await uploadStreamPreview(f);
  f.piece.musicArtwork = (await fixture()).piece.musicArtwork;
  f.pipeline.ready = Promise.resolve(false);
  await uploadStreamPreview(f);
  assert.equal(f.uploads.length, 0);
});

test('thumbnail fetch is cancelled when content stops', async () => {
  const original = global.fetch;
  const f = await fixture();
  f.piece.musicArtwork = null;
  f.piece.thumbnail = 'https://example.com/thumbnail.jpg';
  let fetchSignal;
  global.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    fetchSignal = signal;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  try {
    const task = uploadStreamPreview(f);
    f.piece.control.abort();
    await task;
    assert.equal(fetchSignal.aborted, true);
    assert.equal(f.uploads.length, 0);
  } finally { global.fetch = original; }
});

test('source thumbnail takes priority over music artwork', async () => {
  const original = global.fetch;
  const f = await fixture();
  f.piece.thumbnail = 'https://example.com/thumbnail.jpg';
  const green = await sharp({ create: { width: 32, height: 18, channels: 3, background: '#00ff00' } }).png().toBuffer();
  global.fetch = async () => new Response(green, { headers: { 'content-type': 'image/png' } });
  try {
    await uploadStreamPreview(f);
    const { data } = await sharp(f.uploads[0]).raw().toBuffer({ resolveWithObject: true });
    assert.ok(data[1] > 240);
    assert.ok(data[0] < 10);
  } finally { global.fetch = original; }
});

test('snapshot selection requires parameter sets and a keyframe in one bounded Annex B frame', () => {
  const { standaloneFrame } = require('../src/streambot/streamPreview');
  const nals = (...types) => Buffer.concat(types.map(type => Buffer.from([0, 0, 0, 1, type, 0])));
  assert.equal(standaloneFrame(nals(7, 8, 5), 'H264'), true);
  assert.equal(standaloneFrame(nals(5), 'H264'), false);
  assert.equal(standaloneFrame(nals(7, 8, 1), 'H264'), false);
  assert.equal(standaloneFrame(nals(64, 66, 68, 38), 'H265'), true);
  assert.equal(standaloneFrame(nals(64, 66, 38), 'H265'), false);
  assert.equal(standaloneFrame(Buffer.alloc(3 * 1024 * 1024), 'H264'), false);
  assert.equal(standaloneFrame(nals(7, 8, 5), 'AV1'), false);
});

test('snapshot hook ignores ordinary frames, missing metadata fallback flag, and busy workers', () => {
  const { snapshotPreview } = require('../src/streambot/streamPreview');
  const piece = { control: new AbortController() };
  const manager = {};
  const hook = snapshotPreview({ piece, pipeline: {}, manager, isCurrent: () => true, codec: 'H264' });
  const frame = Buffer.from([0, 0, 1, 7, 0, 0, 1, 8, 0, 0, 1, 5, 0]);
  hook(frame, true);
  assert.equal(manager._previewSnapshotJob, undefined);
  piece.previewFallbackWanted = true;
  hook(frame, false);
  assert.equal(manager._previewSnapshotJob, undefined);
  manager._previewSnapshotJob = {};
  const busy = manager._previewSnapshotJob;
  hook(frame, true);
  assert.equal(manager._previewSnapshotJob, busy);
});

test('snapshot decoder cancellation and spawn failure return no image', async () => {
  const { decodeSnapshot } = require('../src/streambot/streamPreview');
  const control = new AbortController();
  const task = decodeSnapshot(Buffer.alloc(0), 'H264', control.signal, process.execPath);
  control.abort();
  assert.equal(await task, null);
  assert.equal(await decodeSnapshot(Buffer.alloc(0), 'H264', new AbortController().signal, '/missing-preview-ffmpeg'), null);
});

test('fallback snapshots are rate limited and cannot upload obsolete content', async () => {
  const { snapshotPreview } = require('../src/streambot/streamPreview');
  const f = await fixture();
  const manager = {};
  f.piece.previewFallbackWanted = true;
  const frame = Buffer.from([0, 0, 1, 7, 0, 0, 1, 8, 0, 0, 1, 5, 0]);
  let current = true;
  let calls = 0;
  let finish;
  const hook = snapshotPreview({ ...f, manager, isCurrent: () => current, codec: 'H264',
    decode: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  hook(frame, true);
  hook(frame, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  current = false;
  finish(Buffer.from('jpeg'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.uploads.length, 0);
  assert.equal(manager._previewSnapshotJob, null);
  current = true;
  hook(frame, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
});

test('a complete encoded H264 keyframe decodes to a 512 by 288 JPEG', async () => {
  const { spawnSync } = require('node:child_process');
  const { standaloneFrame, decodeSnapshot } = require('../src/streambot/streamPreview');
  const encoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=c=green:s=64x36:r=1', '-frames:v', '1', '-c:v', 'libx264', '-f', 'h264', 'pipe:1']);
  assert.equal(encoded.status, 0);
  assert.equal(standaloneFrame(encoded.stdout, 'H264'), true);
  const jpeg = await decodeSnapshot(encoded.stdout, 'H264', new AbortController().signal);
  assert.ok(jpeg);
  const meta = await sharp(jpeg).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 512);
  assert.equal(meta.height, 288);
});

test('a complete encoded H265 keyframe decodes to a bounded JPEG', async () => {
  const { spawnSync } = require('node:child_process');
  const { standaloneFrame, decodeSnapshot } = require('../src/streambot/streamPreview');
  const encoded = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'color=c=green:s=64x64:r=1', '-frames:v', '1', '-c:v', 'libx265',
    '-x265-params', 'pools=none:frame-threads=1:log-level=error', '-f', 'hevc', 'pipe:1']);
  assert.equal(encoded.status, 0);
  assert.equal(standaloneFrame(encoded.stdout, 'H265'), true);
  const jpeg = await decodeSnapshot(encoded.stdout, 'H265', new AbortController().signal);
  assert.ok(jpeg && jpeg.length <= 256 * 1024);
  const meta = await sharp(jpeg).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 512);
  assert.equal(meta.height, 288);
});
