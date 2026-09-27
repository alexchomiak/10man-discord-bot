'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const test = require('node:test');
const sharp = require('sharp');
const { workerDashboardUrl, createFillerArtwork, fillerCountdownFilter } = require('../src/streambot/fillerArtwork');
const { createMusicArtwork, updateMusicQueue, stopMusicQueueFrames } = require('../src/streambot/musicArtwork');

test('filler links target the selected worker, preserving a reverse-proxy path', () => {
  assert.equal(workerDashboardUrl('https://stream.example.com/player/', 'abcdef'),
    'https://stream.example.com/player/abcdef');
  assert.equal(workerDashboardUrl('https://stream.example.com/player/', 'ghijkl'),
    'https://stream.example.com/player/ghijkl');
  assert.equal(workerDashboardUrl('file:///tmp/dashboard', 'abcdef'), null);
  assert.equal(workerDashboardUrl('https://stream.example.com/', 'one'), null);
});

test('idle and next-up screens render bounded frames, and countdown is time-based', async () => {
  for (const next of [null, { title: 'Example next video', thumbnail: null }]) {
    const artwork = await createFillerArtwork({
      baseUrl: 'https://stream.example.com/', workerId: 'one', accessCode: 'abcdef', next,
      width: 1920, height: 1080
    });
    try {
      const metadata = await sharp(artwork.file).metadata();
      assert.equal(metadata.width, 1920);
      assert.equal(metadata.height, 1080);
      assert.equal(metadata.format, 'png');
      assert.equal(artwork.url, 'https://stream.example.com/abcdef');
    } finally {
      await fs.rm(artwork.directory, { recursive: true, force: true });
    }
  }
  assert.match(fillerCountdownFilter(15), /ceil\(15-t\)/);
});

test('next-up artwork embeds an available thumbnail', async () => {
  const thumbnail = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(thumbnail, { headers: { 'content-type': 'image/png' } });
  let artwork;
  try {
    artwork = await createFillerArtwork({ baseUrl: 'https://stream.example.com/', workerId: 'two', accessCode: 'ghijkl',
      next: { title: 'A new video', thumbnail: 'https://images.example.com/next.png' } });
    const pixel = await sharp(artwork.file).extract({ left: 300, top: 300, width: 1, height: 1 }).raw().toBuffer();
    assert.deepEqual([...pixel.subarray(0, 3)], [255, 0, 0]);
    assert.equal(artwork.url, 'https://stream.example.com/ghijkl');
  } finally {
    global.fetch = originalFetch;
    if (artwork) await fs.rm(artwork.directory, { recursive: true, force: true });
  }
});

test('worker avatar is centered in the blue and neon QR code', async () => {
  const avatar = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#eb5e8a' } }).png().toBuffer();
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(avatar, { headers: { 'content-type': 'image/png' } });
  let artwork;
  try {
    artwork = await createFillerArtwork({ baseUrl: 'https://stream.example.com/', workerId: 'one', accessCode: 'abcdef',
      avatarUrl: 'https://cdn.discordapp.com/avatars/one.png' });
    const center = await sharp(artwork.file).extract({ left: 960, top: 496, width: 1, height: 1 }).raw().toBuffer();
    const quietZone = await sharp(artwork.file).extract({ left: 706, top: 242, width: 1, height: 1 }).raw().toBuffer();
    assert.deepEqual([...center.subarray(0, 3)], [235, 94, 138]);
    assert.deepEqual([...quietZone.subarray(0, 3)], [23, 35, 45]);
  } finally {
    global.fetch = originalFetch;
    if (artwork) await fs.rm(artwork.directory, { recursive: true, force: true });
  }
});

test('music artwork links to its worker and updates the live queue image', async () => {
  const artwork = await createMusicArtwork({ baseUrl: 'https://stream.example.com/player/',
    workerId: 'two', accessCode: 'ghijkl', title: 'Current song', queue: [{ title: 'First song' }] });
  try {
    const metadata = await sharp(artwork.file).metadata();
    assert.equal(metadata.width, 1920);
    assert.equal(metadata.height, 1080);
    assert.equal(artwork.url, 'https://stream.example.com/player/ghijkl');
    assert(artwork.queueFrame.length > 0);
    const first = artwork.queueFrame;
    await updateMusicQueue(artwork, [{ title: 'Second song' }]);
    assert.notDeepEqual(artwork.queueFrame, first);
  } finally {
    stopMusicQueueFrames(artwork);
    await fs.rm(artwork.directory, { recursive: true, force: true });
  }
});

test('chaptered music updates current track and upcoming overlay without replacing the base stream', async () => {
  let position = 0;
  const artwork = await createMusicArtwork({ baseUrl: 'https://stream.example.com/player/',
    workerId: 'one', accessCode: 'abcdef', title: 'Long mix', getPosition: () => position,
    chapters: [{ title: 'Intro', startSec: 0, endSec: 30 },
      { title: 'First track', startSec: 30, endSec: 60 },
      { title: 'Second track', startSec: 60, endSec: 90 }],
    queue: [{ title: 'Another mix' }] });
  try {
    assert.equal(artwork.chaptered, true);
    assert.equal(artwork.chapterIndex, 0);
    assert.equal((await sharp(artwork.queueFrame).metadata()).width, 1920);
    const base = await fs.readFile(artwork.file);
    const first = artwork.queueFrame;
    position = 35;
    await updateMusicQueue(artwork, [{ title: 'Another mix' }]);
    assert.equal(artwork.chapterIndex, 1);
    assert.notDeepEqual(artwork.queueFrame, first);
    assert.deepEqual(await fs.readFile(artwork.file), base);
  } finally {
    stopMusicQueueFrames(artwork);
    await fs.rm(artwork.directory, { recursive: true, force: true });
  }
});

test('music screen composites the worker avatar, current thumbnail, and queued thumbnails', async () => {
  const colors = { avatar: '#eb5e8a', current: '#2196f3', queued: '#ffb020' };
  const bytes = Object.fromEntries(await Promise.all(Object.entries(colors).map(async ([key, color]) =>
    [key, await sharp({ create: { width: 64, height: 64, channels: 3, background: color } }).png().toBuffer()])));
  const originalFetch = global.fetch;
  global.fetch = async url => new Response(bytes[String(url).split('/').pop()],
    { headers: { 'content-type': 'image/png' } });
  let artwork;
  try {
    artwork = await createMusicArtwork({ baseUrl: 'https://stream.example.com/', workerId: 'one', accessCode: 'abcdef',
      title: 'Playing now', thumbnail: 'https://images.example/current',
      avatarUrl: 'https://images.example/avatar',
      queue: [{ title: 'Coming next', thumbnail: 'https://images.example/queued' }] });
    const avatar = await sharp(artwork.file).extract({ left: 500, top: 345, width: 1, height: 1 }).raw().toBuffer();
    const current = await sharp(artwork.file).extract({ left: 500, top: 670, width: 1, height: 1 }).raw().toBuffer();
    const queued = await sharp(artwork.queueFrame).extract({ left: 70, top: 30, width: 1, height: 1 }).raw().toBuffer();
    assert.deepEqual([...avatar.subarray(0, 3)], [235, 94, 138]);
    assert.deepEqual([...current.subarray(0, 3)], [33, 150, 243]);
    assert.deepEqual([...queued.subarray(0, 3)], [255, 176, 32]);
  } finally {
    global.fetch = originalFetch;
    if (artwork) {
      stopMusicQueueFrames(artwork);
      await fs.rm(artwork.directory, { recursive: true, force: true });
    }
  }
});
