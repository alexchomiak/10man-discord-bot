'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const QRCode = require('qrcode');
const sharp = require('sharp');
const { workerDashboardUrl, fetchArtworkImage, circularAvatar } = require('./fillerArtwork');

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
}
function shorten(value, limit) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}
async function translucentImage(image, width, height, opacity = 0.88) {
  if (!image) return null;
  const mask = Buffer.from(`<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="#fff" fill-opacity="${opacity}"/></svg>`);
  return sharp(image).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}
function titleMarkup(title, y = 505) {
  const words = shorten(title || 'Nothing playing', 76).split(' ');
  const lines = [''];
  for (const word of words) {
    const line = lines[lines.length - 1];
    if (line && `${line} ${word}`.length > 37 && lines.length < 2) lines.push(word);
    else lines[lines.length - 1] = line ? `${line} ${word}` : word;
  }
  return lines.map((line, index) =>
    `<tspan x="500" y="${y + index * 40}">${escapeXml(shorten(line, 40))}</tspan>`).join('');
}
function musicSvg(url, workerId, title, hasThumbnail, chaptered = false, visualizer = false) {
  const displayUrl = escapeXml(shorten(url, 67));
  const worker = escapeXml(shorten(workerId.toUpperCase(), 32));
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><style>text{font-family:DejaVu Sans,Arial,sans-serif}</style>
    <rect width="1920" height="1080" fill="#0b111a"${visualizer ? ' fill-opacity="0.12"' : ''}/>
    <rect x="36" y="36" width="1848" height="1008" rx="26" fill="#17232d"${visualizer ? ' fill-opacity="0.38"' : ''} stroke="#344b44" stroke-width="3"/>
    <rect x="960" y="92" width="2" height="896" fill="#344b44"/>
    <rect x="90" y="85" width="56" height="56" rx="14" fill="#d9ff62"/><path d="M109 99 L109 129 L135 114 Z" fill="#17232d"/>
    <text x="165" y="124" font-size="29" font-weight="700" fill="#e8f2f4">10MAN / MUSIC</text>
    <text x="1830" y="124" text-anchor="end" font-size="25" fill="#d9ff62">${worker}</text>
    <text x="500" y="202" text-anchor="middle" font-size="21" letter-spacing="3" fill="#d9ff62">NOW PLAYING</text>
    <rect x="300" y="225" width="400" height="225" rx="16" fill="#0b141c" fill-opacity="${hasThumbnail ? '0.12' : '0.82'}" stroke="#3b5549" stroke-width="2"/>
    ${hasThumbnail ? '' : '<text x="500" y="350" text-anchor="middle" font-size="26" fill="#90a3ae">CURRENT TRACK</text>'}
    ${chaptered ? '' : `<text text-anchor="middle" font-size="30" font-weight="700" fill="#f0f4f6">${titleMarkup(title)}</text>`}
    <text x="500" y="615" text-anchor="middle" font-size="22" letter-spacing="3" fill="#a9bdbe">SCAN TO ADD MUSIC</text>
    <text x="500" y="914" text-anchor="middle" font-size="22" fill="#e9f0f4">Scan the QR code or visit</text>
    <text x="500" y="950" text-anchor="middle" font-size="21" fill="#d9ff62">${displayUrl}</text>
    <text x="500" y="984" text-anchor="middle" font-size="21" fill="#a9bdbe">to add music to the queue.</text>
    <text x="1030" y="225" font-size="29" font-weight="700" letter-spacing="3" fill="#d9ff62">UP NEXT</text>
  </svg>`);
}
function queueSvg(items, { chaptered = false, currentTitle = null } = {}) {
  const all = (items || []).filter(item => !item.isFiller);
  const songs = all.slice(0, 10);
  const x = chaptered ? 1000 : 0;
  const width = chaptered ? 1920 : 820;
  const title = chaptered ? `<text text-anchor="middle" font-family="DejaVu Sans,Arial" font-size="30" font-weight="700" fill="#f0f4f6">${titleMarkup(currentTitle, 240)}</text>` : '';
  if (!songs.length) return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="700">${title}<text x="${x + 15}" y="45" font-family="DejaVu Sans,Arial" font-size="25" fill="#a9bdbe">Nothing queued yet</text></svg>`);
  const cards = songs.map((item, index) => {
    const y = index * 64;
    return `<rect x="${x}" y="${y}" width="810" height="58" rx="8" fill="#20313b" fill-opacity="0.84" stroke="#3b5549" stroke-width="1"/>
      <text x="${x + 10}" y="${y + 38}" font-family="DejaVu Sans,Arial" font-size="20" fill="#a9bdbe">${String(index + 1).padStart(2, '0')}</text>
      <rect x="${x + 45}" y="${y + 7}" width="80" height="45" rx="5" fill="#0b141c" fill-opacity="0.2"/>
      <text x="${x + 139}" y="${y + 38}" font-family="DejaVu Sans,Arial" font-size="23" fill="#f0f4f6">${escapeXml(shorten(item.title || 'Untitled', 47))}</text>`;
  }).join('');
  const more = all.length > songs.length
    ? `<text x="${x + 12}" y="${songs.length * 64 + 29}" font-family="DejaVu Sans,Arial" font-size="22" fill="#d9ff62">+${all.length - songs.length} more queued</text>` : '';
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="700">${title}${cards}${more}</svg>`);
}
function chapterIndex(artwork) {
  if (!artwork.chaptered) return -1;
  const position = artwork.getPosition?.() || 0;
  for (let i = artwork.chapters.length - 1; i >= 0; i--) {
    if (position >= artwork.chapters[i].startSec) return i;
  }
  return -1;
}
async function queueFrame(artwork, items, signal) {
  const chapter = chapterIndex(artwork);
  const chapterItems = artwork.chaptered ? artwork.chapters.slice(chapter + 1).map(item => ({
    title: item.title, thumbnail: artwork.thumbnail })) : [];
  const displayItems = [...chapterItems, ...(items || [])];
  const all = displayItems.filter(item => !item.isFiller);
  const songs = all.slice(0, 10);
  const images = await Promise.all(songs.map(async item => {
    if (!item.thumbnail) return null;
    if (!artwork.thumbnailCache.has(item.thumbnail)) {
      artwork.thumbnailCache.set(item.thumbnail,
        fetchArtworkImage(item.thumbnail, { width: 80, height: 45 }, signal)
          .then(image => translucentImage(image, 80, 45)));
    }
    return artwork.thumbnailCache.get(item.thumbnail);
  }));
  signal?.throwIfAborted();
  const used = new Set(songs.map(item => item.thumbnail).filter(Boolean));
  for (const url of artwork.thumbnailCache.keys()) {
    if (!used.has(url)) artwork.thumbnailCache.delete(url);
  }
  const composites = images.flatMap((image, index) => image ? [{ input: image,
    left: (artwork.chaptered ? 1000 : 0) + 45, top: index * 64 + 7 }] : []);
  const currentTitle = chapter >= 0 ? artwork.chapters[chapter].title : artwork.title;
  const frame = await sharp(queueSvg(displayItems, { chaptered: artwork.chaptered, currentTitle }))
    .composite(composites).png().toBuffer();
  artwork.chapterIndex = chapter;
  return frame;
}
function startMusicQueueFrames(artwork) {
  if (artwork.timer) return;
  const push = () => {
    if (artwork.queueStream.destroyed || !artwork.queueFrame) return;
    // A slow FFmpeg reader must never cause an unbounded Node-side image queue.
    if (artwork.queueStream.writableLength < artwork.queueFrame.length) artwork.queueStream.write(artwork.queueFrame);
  };
  push();
  artwork.timer = setInterval(push, 100);
  artwork.timer.unref?.();
  if (artwork.chaptered) {
    artwork.chapterTimer = setInterval(() => {
      if (chapterIndex(artwork) !== artwork.chapterIndex) {
        void updateMusicQueue(artwork, artwork.queueItems, artwork.signal).catch(() => {});
      }
    }, 500);
    artwork.chapterTimer.unref?.();
  }
}
function stopMusicQueueFrames(artwork) {
  if (!artwork) return;
  clearInterval(artwork.timer);
  clearInterval(artwork.chapterTimer);
  artwork.timer = null;
  artwork.chapterTimer = null;
  artwork.queueStream?.destroy();
  artwork.thumbnailCache?.clear();
}
async function createMusicArtwork({ baseUrl, workerId, accessCode, randomCodes = false, title, thumbnail = null, avatarUrl = null,
  queue = [], chapters = null, getPosition = null, width = 1920, height = 1080, visualizer = false, signal }) {
  const url = workerDashboardUrl(baseUrl, randomCodes ? accessCode : workerId);
  if (!url) throw new Error('STREAM_DASHBOARD_BASE_URL must be an http(s) dashboard URL for Music Mode');
  signal?.throwIfAborted();
  const [qr, currentThumbnail, avatarImage] = await Promise.all([
    QRCode.toBuffer(url, { type: 'png', width: 230, margin: 3,
      errorCorrectionLevel: 'H', color: { dark: '#d9ff62', light: '#17232d' } }),
    thumbnail ? fetchArtworkImage(thumbnail, { width: 384, height: 216 }, signal) : null,
    avatarUrl ? fetchArtworkImage(avatarUrl, { width: 48, height: 48 }, signal) : null
  ]);
  signal?.throwIfAborted();
  const composites = [{ input: qr, left: 385, top: 640 }];
  if (currentThumbnail) composites.push({ input: await translucentImage(currentThumbnail, 384, 216), left: 308, top: 230 });
  const avatar = await circularAvatar(avatarImage, 48);
  if (avatar) {
    const ring = Buffer.from('<svg width="60" height="60"><circle cx="30" cy="30" r="28" fill="#17232d" stroke="#d9ff62" stroke-width="3"/></svg>');
    composites.push({ input: ring, left: 470, top: 725 });
    composites.push({ input: avatar, left: 476, top: 731 });
  }
  const chaptered = Array.isArray(chapters) && chapters.length > 1;
  const image = await sharp(musicSvg(url, workerId, title, !!currentThumbnail, chaptered, visualizer))
    .composite(composites).resize(width, height).png().toBuffer();
  signal?.throwIfAborted();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sbot-music-'));
  try {
    const file = path.join(directory, 'frame.png');
    await fs.writeFile(file, image, { mode: 0o600 });
    const artwork = { file, directory, url, visualizer, queueStream: new PassThrough({ highWaterMark: 512 * 1024 }),
      title, thumbnail, chapters, chaptered, chapterIndex: -1, getPosition,
      queueItems: [...queue], signal, thumbnailCache: new Map(), queueFrame: null, timer: null };
    artwork.queueFrame = await queueFrame(artwork, queue, signal);
    return artwork;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}
async function updateMusicQueue(artwork, queue, signal) {
  if (!artwork?.queueStream || artwork.queueStream.destroyed) return;
  artwork.queueItems = [...queue];
  if (artwork.rendering) { artwork.dirty = true; return; }
  artwork.rendering = true;
  try {
    do {
      artwork.dirty = false;
      const frame = await queueFrame(artwork, artwork.queueItems, signal);
      if (!artwork.queueStream.destroyed) artwork.queueFrame = frame;
    } while (artwork.dirty && !artwork.queueStream.destroyed);
  } finally { artwork.rendering = false; }
}
module.exports = { createMusicArtwork, updateMusicQueue, startMusicQueueFrames,
  stopMusicQueueFrames };
