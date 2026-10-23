'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const sharp = require('sharp');
const { workerDashboardUrl, createFillerArtwork, fillerCountdownFilter } = require('../src/streambot/fillerArtwork');
const { musicQueueFilter, createMusicArtwork, updateMusicQueue, stopMusicQueueFrames } = require('../src/streambot/musicArtwork');
const { musicVisualizerFilter } = require('../src/streambot/musicVisualizer');

test('filler links target the selected worker, preserving a reverse-proxy path', () => {
  assert.equal(workerDashboardUrl('https://stream.example.com/player/', 'one'),
    'https://stream.example.com/player/one');
  assert.equal(workerDashboardUrl('https://stream.example.com/player/', 'youtube'),
    'https://stream.example.com/player/youtube');
  assert.equal(workerDashboardUrl('file:///tmp/dashboard', 'one'), null);
  assert.equal(workerDashboardUrl('https://stream.example.com/', '../one'), null);
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
      assert.equal(artwork.url, 'https://stream.example.com/one');
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
    assert.equal(artwork.url, 'https://stream.example.com/two');
  } finally {
    global.fetch = originalFetch;
    if (artwork) await fs.rm(artwork.directory, { recursive: true, force: true });
  }
});

test('opt-in random links use the worker session code in QR artwork', async () => {
  const artwork = await createFillerArtwork({ baseUrl: 'https://stream.example.com/player/',
    workerId: 'one', accessCode: 'abcdef', randomCodes: true });
  try { assert.equal(artwork.url, 'https://stream.example.com/player/abcdef'); }
  finally { await fs.rm(artwork.directory, { recursive: true, force: true }); }
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
    assert.equal(artwork.url, 'https://stream.example.com/player/two');
    assert(artwork.queueFrame.length > 0);
    const first = artwork.queueFrame;
    await updateMusicQueue(artwork, [{ title: 'Second song' }]);
    assert.notDeepEqual(artwork.queueFrame, first);
  } finally {
    stopMusicQueueFrames(artwork);
    await fs.rm(artwork.directory, { recursive: true, force: true });
  }
});

test('music visualizer artwork keeps its background translucent and reuses one FFT for the reflection', async () => {
  const artwork = await createMusicArtwork({ baseUrl: 'https://stream.example.com/', workerId: 'one',
    title: 'Song', visualizer: true });
  try {
    const pixel = await sharp(artwork.file).extract({ left: 100, top: 300, width: 1, height: 1 })
      .ensureAlpha().raw().toBuffer();
    assert(pixel[3] > 0 && pixel[3] < 255);
    assert.equal(artwork.visualizer, true);
    const filter = musicVisualizerFilter({ width: 1920, height: 1080, fps: 30 });
    assert.equal((filter.match(/showfreqs=/g) || []).length, 1);
    assert.match(filter, /vflip/);
    assert.match(filter, /volume=8/);
    assert.match(filter, /averaging=1/);
    assert.match(filter, /gradients=.*nb_colors=2:c0=0xbca3d4:c1=0x88bdd3/);
    assert.match(filter, /overlay=96:626/);
    assert.match(filter, /overlay=96:799/);
    assert.equal((filter.match(/eof_action=pass:repeatlast=0/g) || []).length, 2);
  } finally {
    stopMusicQueueFrames(artwork);
    await fs.rm(artwork.directory, { recursive: true, force: true });
  }
});

test('music visualizer clears its bars when the audio input ends before the background', () => {
  const hashes = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args,
    '-f', 'framehash', 'pipe:1'], { encoding: 'utf8' })
    .split('\n').filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(',').at(-1).trim());
  const background = ['-f', 'lavfi', '-i', 'color=c=0x14232c:s=320x180:r=30:d=2'];
  const baseHash = hashes([...background, '-vf', 'format=rgb24', '-frames:v', '1'])[0];
  const filter = '[0:v]null[base];' + musicVisualizerFilter({ width: 320, height: 180, fps: 30 }) +
    '[visual]format=rgb24[out]';
  const frames = hashes([...background, '-f', 'lavfi', '-i',
    'anoisesrc=color=pink:sample_rate=48000:d=0.5', '-filter_complex', filter,
    '-map', '[out]', '-t', '2']);
  assert.notEqual(frames[5], baseHash, 'bars react while audio is present');
  assert.equal(frames[45], baseHash, 'ended audio must not leave frozen bars');
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
    const avatar = await sharp(artwork.file).extract({ left: 500, top: 755, width: 1, height: 1 }).raw().toBuffer();
    const current = await sharp(artwork.file).extract({ left: 500, top: 330, width: 1, height: 1 }).raw().toBuffer();
    const queued = await sharp(artwork.queueFrame).extract({ left: 70, top: 30, width: 1, height: 1 }).raw().toBuffer();
    const card = await sharp(artwork.queueFrame).extract({ left: 300, top: 10, width: 1, height: 1 }).raw().toBuffer();
    assert.deepEqual([...avatar.subarray(0, 3)], [235, 94, 138]);
    assert(current[2] > current[0] * 2 && current[2] > current[1]);
    assert(queued[0] > queued[1] && queued[1] > queued[2], `Queued thumbnail pixel: ${[...queued]}`);
    assert(queued[3] < 255);
    assert(card[3] >= 158 && card[3] <= 174);
  } finally {
    global.fetch = originalFetch;
    if (artwork) {
      stopMusicQueueFrames(artwork);
      await fs.rm(artwork.directory, { recursive: true, force: true });
    }
  }
});

test('all output resolutions keep QR, avatar and thumbnails in their design bounds', async () => {
  const assets = Object.fromEntries(await Promise.all([
    ['avatar', '#eb5e8a', 64, 64], ['thumbnail', '#ff0000', 160, 90]
  ].map(async ([name, background, width, height]) => [name,
    await sharp({ create: { width, height, channels: 3, background } }).png().toBuffer()])));
  const originalFetch = global.fetch;
  global.fetch = async url => new Response(assets[String(url).split('/').pop()],
    { headers: { 'content-type': 'image/png' } });
  const dimensions = [[1280, 720], [1920, 1080], [2560, 1440], [3840, 2160]];
  // Inspect rendered pixels, including the complete bounding box of each asset.
  // This catches Sharp moving resize ahead of composite in a single pipeline.
  const bounds = (data, info, predicate, region = [0, 0, info.width, info.height]) => {
    const result = { left: Infinity, top: Infinity, right: -1, bottom: -1 };
    for (let y = region[1]; y < region[3]; y++) for (let x = region[0]; x < region[2]; x++) {
      const offset = (y * info.width + x) * info.channels;
      if (!predicate(data[offset], data[offset + 1], data[offset + 2])) continue;
      result.left = Math.min(result.left, x); result.right = Math.max(result.right, x);
      result.top = Math.min(result.top, y); result.bottom = Math.max(result.bottom, y);
    }
    assert(result.right >= 0, 'rendered asset must exist');
    return result;
  };
  const near = (actual, expected, label) => assert(Math.abs(actual - expected) <= 3,
    `${label}: expected ${expected}, got ${actual}`);
  try {
    for (const [width, height] of dimensions) for (const mode of ['idle', 'next', 'music']) {
      const scale = width / 1920;
      const common = { baseUrl: 'https://stream.example.com/', workerId: 'one', width, height,
        avatarUrl: 'https://images.example/avatar' };
      const artwork = mode === 'music'
        ? await createMusicArtwork({ ...common, title: 'Current track', thumbnail: 'https://images.example/thumbnail' })
        : await createFillerArtwork({ ...common, next: mode === 'next'
          ? { title: 'Next video', thumbnail: 'https://images.example/thumbnail' } : null });
      try {
        const { data, info } = await sharp(artwork.file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        assert.equal(info.width, width); assert.equal(info.height, height);
        const avatar = bounds(data, info, (r, g, b) => r > 220 && r < 245 && g > 80 && g < 110 && b > 120 && b < 155);
        const [cx, cy, size] = mode === 'music' ? [500, 755, 48]
          : mode === 'next' ? [1450, 465, 72] : [960, 496, 92];
        near((avatar.left + avatar.right + 1) / 2, cx * scale, `${mode}/${height} avatar x`);
        near((avatar.top + avatar.bottom + 1) / 2, cy * scale, `${mode}/${height} avatar y`);
        near(avatar.right - avatar.left + 1, size * scale, `${mode}/${height} avatar width`);
        if (mode !== 'idle') {
          const thumbnail = bounds(data, info, (r, g, b) => r > 200 && g < 10 && b < 10);
          const [left, top, tw, th] = mode === 'music' ? [308, 230, 384, 216] : [90, 205, 920, 518];
          near(thumbnail.left, left * scale, `${mode}/${height} thumbnail left`);
          near(thumbnail.top, top * scale, `${mode}/${height} thumbnail top`);
          near(thumbnail.right + 1, (left + tw) * scale, `${mode}/${height} thumbnail right`);
          near(thumbnail.bottom + 1, (top + th) * scale, `${mode}/${height} thumbnail bottom`);
        }
        const [ql, qt, qs] = mode === 'music' ? [385, 640, 230]
          : mode === 'next' ? [1240, 255, 420] : [704, 240, 512];
        const qr = bounds(data, info, (r, g, b) => r > 200 && g > 235 && b < 130,
          [Math.floor(ql * scale), Math.floor(qt * scale), Math.ceil((ql + qs) * scale), Math.ceil((qt + qs) * scale)]);
        // QR foreground is inset by its quiet zone and spans most of the square.
        assert(qr.left > ql * scale && qr.right < (ql + qs) * scale);
        assert(qr.top > qt * scale && qr.bottom < (qt + qs) * scale);
        assert(qr.right - qr.left > qs * scale * 0.75);
        assert(qr.bottom - qr.top > qs * scale * 0.75);
        if (mode === 'next') assert(qr.left > 1010 * scale, 'QR stays to the right of next-video panel');
      } finally {
        stopMusicQueueFrames(artwork);
        await fs.rm(artwork.directory, { recursive: true, force: true });
      }
    }
  } finally { global.fetch = originalFetch; }
});

test('FFmpeg scales normal and chaptered live queue overlays with the output resolution', async () => {
  const thumbnail = await sharp({ create: { width: 160, height: 90, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(thumbnail, { headers: { 'content-type': 'image/png' } });
  try {
    for (const chaptered of [false, true]) {
      const artwork = await createMusicArtwork({ baseUrl: 'https://stream.example.com/', workerId: 'one', title: 'Mix',
        chapters: chaptered ? [{ title: 'Intro', startSec: 0 }, { title: 'Next chapter', startSec: 30 }] : null,
        getPosition: () => 0, thumbnail: 'https://images.example/thumbnail',
        queue: Array.from({ length: 10 }, (_, index) => ({ title: `Queued song ${index + 1}`,
          thumbnail: 'https://images.example/thumbnail' })) });
      try {
        const queueFile = `${artwork.directory}/queue.png`;
        await fs.writeFile(queueFile, artwork.queueFrame);
        for (const [width, height] of [[1280, 720], [1920, 1080], [2560, 1440], [3840, 2160]]) {
          const output = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', `color=c=0x17232d:s=${width}x${height}`, '-i', queueFile, '-i', queueFile,
            '-filter_complex', `[0:v]format=rgba[stage];${musicQueueFilter({ width, height, chaptered })}[out]`,
            '-map', '[out]', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { maxBuffer: 8 * 1024 * 1024 });
          const { data, info } = await sharp(output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
          let left = width, right = -1, top = height, bottom = -1;
          for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const i = (y * width + x) * info.channels;
            if (data[i] > 120 && data[i + 1] < 35 && data[i + 2] < 45) {
              left = Math.min(left, x); right = Math.max(right, x);
              top = Math.min(top, y); bottom = Math.max(bottom, y);
            }
          }
          const scale = width / 1920;
          assert(Math.abs(left - 1045 * scale) <= 3, `queue left ${left} at ${height}`);
          assert(Math.abs(top - 272 * scale) <= 3, `queue top ${top} at ${height}`);
          assert(Math.abs(right + 1 - 1125 * scale) <= 3, `queue right ${right} at ${height}`);
          const lastRow = 9;
          assert(Math.abs(bottom + 1 - (317 + lastRow * 64) * scale) <= 3, `queue bottom ${bottom} at ${height}`);
          assert(right < width && bottom < height, 'queue thumbnails remain inside output');
          if (chaptered) {
            let titlePixels = 0;
            for (let y = Math.floor(480 * scale); y < Math.ceil(550 * scale); y++) {
              for (let x = Math.floor(200 * scale); x < Math.ceil(800 * scale); x++) {
                const i = (y * width + x) * info.channels;
                if (data[i] > 220 && data[i + 1] > 220 && data[i + 2] > 220) titlePixels++;
              }
            }
            assert(titlePixels > 20, `chapter title remains in the now-playing panel at ${height}`);
          }
        }
      } finally {
        stopMusicQueueFrames(artwork);
        await fs.rm(artwork.directory, { recursive: true, force: true });
      }
    }
  } finally { global.fetch = originalFetch; }
});


test('visualizer bars and reflection stay inside every supported output frame', () => {
  for (const [width, height] of [[1280, 720], [1920, 1080], [2560, 1440], [3840, 2160]]) {
    const filter = musicVisualizerFilter({ width, height, fps: 30 });
    const overlays = [...filter.matchAll(/overlay=(\d+):(\d+)/g)].map(match => [Number(match[1]), Number(match[2])]);
    const [, bw, bh] = /scale=(\d+):(\d+):flags=neighbor/.exec(filter).map(Number);
    assert.equal(overlays.length, 2);
    assert(Math.abs(bw / width - 0.9) < 0.025);
    assert(overlays.every(([x, y]) => x >= 0 && y >= 0 && x + bw <= width && y + bh <= height));
    assert.equal(overlays[1][1], overlays[0][1] + bh);
  }
});
