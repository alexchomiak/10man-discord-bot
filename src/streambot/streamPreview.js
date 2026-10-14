'use strict';

const sharp = require('sharp');
const { spawn } = require('node:child_process');
const { fetchArtworkImage } = require('./fillerArtwork');

// One still per piece; independent of media decoding and playback pacing.
async function uploadStreamPreview({ piece, pipeline, isCurrent, onFailure = () => {}, signal = piece.control.signal }) {
  piece.previewFallbackWanted = false;
  let abort;
  try {
    if (signal.aborted || !isCurrent()) return;
    const artwork = piece.musicArtwork || piece.fillerArtwork;
    const sourceImage = piece.thumbnail
      ? await fetchArtworkImage(piece.thumbnail, { width: 512, height: 288 }, signal)
      : null;
    if (signal.aborted || !isCurrent()) return;
    piece.previewSourceImageFailed = Boolean(piece.thumbnail && !sourceImage);
    const image = sourceImage || artwork?.file;
    if (!image) {
      piece.previewFallbackWanted = !artwork && !signal.aborted && isCurrent();
      return;
    }
    if (signal.aborted || !isCurrent()) return;
    const jpeg = await sharp(image, { limitInputPixels: 4096 * 4096 })
      .resize(512, 288, { fit: 'contain', background: '#0b111a' })
      .flatten({ background: '#0b111a' }).jpeg({ quality: 80 }).toBuffer();
    const cancelled = new Promise(resolve => {
      abort = () => resolve(false);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    const ready = await Promise.race([pipeline.ready, cancelled]);
    if (!ready || signal.aborted || !isCurrent()) return;
    await pipeline.streamer.setStreamPreview(jpeg);
    return true;
  } catch {
    // URLs and upload errors can contain credentials; never log their details.
    if (!signal.aborted && isCurrent()) onFailure();
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

function programmeImage(programme, baseUrl) {
  if (typeof programme?.icon_url !== 'string' || !programme.icon_url.trim()) return null;
  try {
    const url = new URL(programme.icon_url, baseUrl);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}
function programmePreviewKey(programme, image) {
  let imagePath = '';
  try { const url = new URL(image); imagePath = url.origin + url.pathname; } catch {}
  return JSON.stringify([programme?.id ?? null, programme?.title, programme?.end_at ?? null, imagePath]);
}

// Require a complete independently decodable Annex B frame. Do not retain
// parameter sets from preceding frames or inspect packets on every send.
function standaloneFrame(frame, codec) {
  if (!Buffer.isBuffer(frame) || frame.length > 2 * 1024 * 1024) return false;
  const types = new Set();
  for (let i = 0; i + 4 < frame.length; i++) {
    if (frame[i] || frame[i + 1]) continue;
    const prefix = frame[i + 2] === 1 ? 3 : frame[i + 2] === 0 && frame[i + 3] === 1 ? 4 : 0;
    if (prefix) types.add(codec === 'H264' ? frame[i + prefix] & 31 : (frame[i + prefix] >> 1) & 63);
  }
  return codec === 'H264' ? types.has(7) && types.has(8) && types.has(5)
    : codec === 'H265' && [32, 33, 34].every(type => types.has(type)) &&
      [16, 17, 18, 19, 20, 21].some(type => types.has(type));
}

function decodeSnapshot(frame, codec, signal, ffmpegPath = 'ffmpeg') {
  return new Promise(resolve => {
    if (signal.aborted) return resolve(null);
    let child;
    try {
      child = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-threads', '1',
        '-f', codec === 'H264' ? 'h264' : 'hevc', '-i', 'pipe:0', '-frames:v', '1',
        '-vf', 'scale=512:288:force_original_aspect_ratio=decrease,pad=512:288:(ow-iw)/2:(oh-ih)/2',
        '-filter_threads', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-threads', '1', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch { return resolve(null); }
    const chunks = [];
    let bytes = 0;
    let done = false;
    const finish = image => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      try { child.kill('SIGKILL'); } catch {}
      resolve(image);
    };
    const cancel = () => finish(null);
    const timer = setTimeout(cancel, 3000);
    timer.unref?.();
    signal.addEventListener('abort', cancel, { once: true });
    child.on('error', cancel);
    child.stdin.on('error', cancel);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 256 * 1024) cancel();
      else chunks.push(chunk);
    });
    child.on('close', code => finish(code === 0 && bytes ? Buffer.concat(chunks) : null));
    child.stdin.end(frame);
  });
}

// Runs only when source images and existing artwork are absent. One selected
// keyframe at most per minute, one short decoder per manager, never awaited by
// media sending. The copy is made before the demuxer frees its native packet.
function snapshotPreview({ piece, pipeline, manager, isCurrent, codec, ffmpegPath, decode = decodeSnapshot }) {
  let nextScan = 0;
  return (frame, isKeyframe) => {
    if (!isKeyframe || !piece.previewFallbackWanted || piece.control.signal.aborted || !isCurrent() ||
        manager._previewSnapshotJob || Date.now() < nextScan ||
        Date.now() < (manager._previewSnapshotAt || 0) + 60000 || !['H264', 'H265'].includes(codec)) return;
    nextScan = Date.now() + 1000;
    if (!standaloneFrame(frame, codec)) return;
    manager._previewSnapshotAt = Date.now();
    const copied = Buffer.from(frame);
    const token = {};
    manager._previewSnapshotJob = token;
    setImmediate(async () => {
      try {
        const jpeg = await decode(copied, codec, piece.control.signal, ffmpegPath);
        if (jpeg && piece.previewFallbackWanted && !piece.control.signal.aborted && isCurrent()) await pipeline.streamer.setStreamPreview(jpeg);
      } catch { /* Still previews must never interrupt playback. */ }
      finally { if (manager._previewSnapshotJob === token) manager._previewSnapshotJob = null; }
    });
  };
}

module.exports = { uploadStreamPreview, programmeImage, programmePreviewKey, standaloneFrame, decodeSnapshot, snapshotPreview };
