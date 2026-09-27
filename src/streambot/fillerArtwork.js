'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const QRCode = require('qrcode');
const sharp = require('sharp');

// Rendering is a one-off operation per filler piece, never a per-frame Node task.
sharp.cache(false);

function workerDashboardUrl(baseUrl, accessCode) {
  if (!baseUrl || !/^[a-z]{6}$/.test(accessCode || '')) return null;
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    url.search = '';
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${accessCode}`;
    return url.toString();
  } catch { return null; }
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

function shorten(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function titleLines(value) {
  const words = shorten(value || 'Coming up next', 74).split(' ');
  const lines = [''];
  for (const word of words) {
    const current = lines.length - 1;
    if (lines[current] && `${lines[current]} ${word}`.length > 38 && lines.length < 2) lines.push(word);
    else lines[current] += `${lines[current] ? ' ' : ''}${word}`;
  }
  return lines.map((line, index) => `<text x="90" y="${index ? 867 : 817}" font-size="39" font-weight="700" fill="#f0f4f6">${escapeXml(line)}</text>`).join('');
}

async function fetchArtworkImage(url, { width, height, timeoutMs = 800 }, signal) {
  if (!/^https?:\/\//i.test(url || '')) return null;
  try {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok || !/^image\/(?:jpeg|png|webp)(?:;|$)/i.test(response.headers.get('content-type') || '')) return null;
    const length = Number(response.headers.get('content-length'));
    if (length > 3 * 1024 * 1024) return null;
    let bytes = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 3 * 1024 * 1024) { await response.body.cancel().catch(() => {}); return null; }
      chunks.push(chunk);
    }
    return await sharp(Buffer.concat(chunks), { limitInputPixels: 4096 * 4096 })
      .resize(width, height, { fit: 'cover' }).png().toBuffer();
  } catch { return null; }
}

async function circularAvatar(image, size) {
  if (!image) return null;
  const mask = Buffer.from(`<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/></svg>`);
  return sharp(image).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

function artworkSvg({ url, workerId, next, hasThumbnail }) {
  const visibleUrl = escapeXml(shorten(url, 100));
  const tag = escapeXml(shorten(workerId, 32).toUpperCase());
  const frame = `<rect width="1920" height="1080" fill="#0b111a"/><rect x="40" y="40" width="1840" height="1000" rx="28" fill="#17232d" stroke="#344b44" stroke-width="3"/>`;
  const brand = `<rect x="90" y="87" width="56" height="56" rx="14" fill="#d9ff62"/><path d="M109 100 L109 130 L135 115 Z" fill="#17232d"/><text x="166" y="126" font-size="30" font-weight="700" fill="#e8f2f4">10MAN / STREAM</text><text x="1830" y="126" text-anchor="end" font-size="26" font-weight="700" fill="#d9ff62">${tag}</text>`;
  const footer = `<text x="960" y="938" text-anchor="middle" font-size="25" fill="#e9f0f4">Scan the QR code or visit <tspan fill="#d9ff62">${visibleUrl}</tspan></text><text x="960" y="978" text-anchor="middle" font-size="23" fill="#a9bdbe">to queue more content!</text>`;
  const body = next
    ? `<rect x="90" y="205" width="920" height="518" rx="18" fill="#0b141c" stroke="#3b5549" stroke-width="3"/>${hasThumbnail ? '' : '<text x="550" y="475" text-anchor="middle" font-size="36" fill="#90a3ae">NEXT VIDEO</text>'}<text x="90" y="765" font-size="24" letter-spacing="4" fill="#d9ff62">UP NEXT</text>${titleLines(next.title)}<text x="1450" y="735" text-anchor="middle" font-size="26" fill="#b7c9c4">SCAN TO QUEUE</text>`
    : `<text x="960" y="165" text-anchor="middle" font-size="40" font-weight="700" fill="#f0f4f6">This is filler content</text><text x="960" y="820" text-anchor="middle" font-size="32" fill="#e9f0f4">Queue playback at</text><text x="960" y="870" text-anchor="middle" font-size="29" fill="#d9ff62">${visibleUrl}</text><text x="960" y="923" text-anchor="middle" font-size="28" fill="#b7c9c4">or scan the QR code</text>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080"><style>text{font-family:DejaVu Sans,Arial,sans-serif}</style>${frame}${brand}${body}${next ? footer : ''}</svg>`);
}

async function createFillerArtwork({ baseUrl, workerId, accessCode, avatarUrl = null, next = null, width = 1920, height = 1080, signal }) {
  const url = workerDashboardUrl(baseUrl, accessCode);
  if (!url) throw new Error('STREAM_DASHBOARD_BASE_URL must be an http(s) dashboard URL');
  signal?.throwIfAborted();
  const qrSize = next ? 420 : 512;
  const qrLeft = next ? 1240 : 704;
  const qrTop = next ? 255 : 240;
  const avatarSize = next ? 72 : 92;
  const [qr, thumbnail, avatarImage] = await Promise.all([
    QRCode.toBuffer(url, { type: 'png', width: qrSize, margin: 3, errorCorrectionLevel: 'H',
      color: { dark: '#d9ff62', light: '#17232d' } }),
    next?.thumbnail ? fetchArtworkImage(next.thumbnail, { width: 920, height: 518 }, signal) : null,
    avatarUrl ? fetchArtworkImage(avatarUrl, { width: avatarSize, height: avatarSize }, signal) : null
  ]);
  signal?.throwIfAborted();
  const composites = [{ input: qr, left: qrLeft, top: qrTop }];
  if (thumbnail) composites.push({ input: thumbnail, left: 90, top: 205 });
  const avatar = await circularAvatar(avatarImage, avatarSize);
  if (avatar) {
    const ringSize = next ? 88 : 112;
    const ringLeft = qrLeft + Math.round((qrSize - ringSize) / 2);
    const ringTop = qrTop + Math.round((qrSize - ringSize) / 2);
    const ring = Buffer.from(`<svg width="${ringSize}" height="${ringSize}"><circle cx="${ringSize / 2}" cy="${ringSize / 2}" r="${ringSize / 2 - 1}" fill="#17232d" stroke="#d9ff62" stroke-width="4"/></svg>`);
    composites.push({ input: ring, left: ringLeft, top: ringTop });
    composites.push({ input: avatar, left: ringLeft + Math.round((ringSize - avatarSize) / 2),
      top: ringTop + Math.round((ringSize - avatarSize) / 2) });
  }
  const image = await sharp(artworkSvg({ url, workerId, next, hasThumbnail: !!thumbnail }))
    .composite(composites).resize(width, height).png().toBuffer();
  signal?.throwIfAborted();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sbot-filler-'));
  try {
    const file = path.join(directory, 'frame.png');
    await fs.writeFile(file, image, { mode: 0o600 });
    return { file, directory, url };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

// FFmpeg evaluates the expression against the image's presentation timestamp.
// A 15-second piece displays 15, 14, ... 1 while retaining a single input.
function fillerCountdownFilter(durationSec, width = 1920, height = 1080) {
  const seconds = Math.max(1, Math.round(durationSec));
  const scale = Math.min(width / 1920, height / 1080);
  const size = Math.max(20, Math.round(42 * scale));
  const x = Math.round(90 * width / 1920);
  const y = Math.round(890 * height / 1080);
  const expression = `%{eif\\:max(0\\,ceil(${seconds}-t))\\:d}`;
  return `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='Up next in ${expression}s':fontsize=${size}:fontcolor=white:x=${x}:y=${y}`;
}

module.exports = { workerDashboardUrl, createFillerArtwork, fillerCountdownFilter,
  fetchArtworkImage, circularAvatar };
