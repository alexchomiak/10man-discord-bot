'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const test = require('node:test');
const sharp = require('sharp');
const { workerDashboardUrl, createFillerArtwork, fillerCountdownFilter } = require('../src/streambot/fillerArtwork');

test('filler links target the selected worker, preserving a reverse-proxy path', () => {
  assert.equal(workerDashboardUrl('https://stream.example.com/player/', 'one'),
    'https://stream.example.com/player/#/one');
  assert.equal(workerDashboardUrl('https://stream.example.com/player/', 'two'),
    'https://stream.example.com/player/#/two');
  assert.equal(workerDashboardUrl('file:///tmp/dashboard', 'one'), null);
});

test('idle and next-up screens render bounded frames, and countdown is time-based', async () => {
  for (const next of [null, { title: 'Example next video', thumbnail: null }]) {
    const artwork = await createFillerArtwork({
      baseUrl: 'https://stream.example.com/', workerId: 'one', next,
      width: 1920, height: 1080
    });
    try {
      const metadata = await sharp(artwork.file).metadata();
      assert.equal(metadata.width, 1920);
      assert.equal(metadata.height, 1080);
      assert.equal(metadata.format, 'png');
      assert.equal(artwork.url, 'https://stream.example.com/#/one');
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
    artwork = await createFillerArtwork({ baseUrl: 'https://stream.example.com/', workerId: 'two',
      next: { title: 'A new video', thumbnail: 'https://images.example.com/next.png' } });
    const pixel = await sharp(artwork.file).extract({ left: 300, top: 300, width: 1, height: 1 }).raw().toBuffer();
    assert.deepEqual([...pixel.subarray(0, 3)], [255, 0, 0]);
    assert.equal(artwork.url, 'https://stream.example.com/#/two');
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
    artwork = await createFillerArtwork({ baseUrl: 'https://stream.example.com/', workerId: 'one',
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
