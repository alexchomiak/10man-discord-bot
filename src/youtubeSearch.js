'use strict';

const { spawn } = require('node:child_process');

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function resultThumbnail(entry, id) {
  const candidates = [entry?.thumbnail, ...(Array.isArray(entry?.thumbnails)
    ? [...entry.thumbnails].sort((a, b) => Math.abs((a?.width || 0) - 480) - Math.abs((b?.width || 0) - 480)).map(item => item?.url)
    : [])];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' && ['i.ytimg.com', 'img.youtube.com'].includes(url.hostname)
        && url.pathname.startsWith(`/vi/${id}/`)) return url.href;
    } catch { /* Ignore malformed extractor metadata. */ }
  }
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

function normalizeResults(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.slice(0, 10).flatMap(entry => {
    const id = String(entry?.id || '');
    if (!VIDEO_ID.test(id) || ['private', 'needs_auth', 'unavailable'].includes(entry.availability)) return [];
    return [{ id, url: `https://www.youtube.com/watch?v=${id}`,
      title: String(entry.title || 'YouTube video').slice(0, 200),
      description: typeof entry.description === 'string' ? entry.description.replace(/\s+/g, ' ').slice(0, 280) : '',
      durationSec: Number.isFinite(entry.duration) && entry.duration > 0 ? entry.duration : null,
      thumbnail: resultThumbnail(entry, id) }];
  });
}

function searchYoutube(query, { bin = process.env.YTDLP_PATH || 'yt-dlp', cookiesFile = process.env.YTDLP_COOKIES_FILE || '', page = 1 } = {}) {
  return new Promise((resolve, reject) => {
    if (!Number.isInteger(page) || page < 1 || page > 20) return reject(new Error('Invalid search page.'));
    const start = (page - 1) * 10 + 1;
    const end = page * 10;
    const args = ['--ignore-config', '--js-runtimes', 'node', '--flat-playlist', '--dump-single-json',
      '--no-warnings', '--playlist-start', String(start), '--playlist-end', String(end),
      ...(cookiesFile ? ['--cookies', cookiesFile] : []), `ytsearch${end}:${query}`];
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let tooLarge = false;
    let finished = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 20000);
    const finish = (error, results) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(results);
    };
    child.stdout.on('data', chunk => {
      if (stdout.length + chunk.length > 1024 * 1024) { tooLarge = true; child.kill('SIGKILL'); return; }
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => { if (stderr.length < 1024) stderr += chunk.toString().slice(0, 1024 - stderr.length); });
    child.on('error', error => finish(new Error(error.code === 'ENOENT' ? 'yt-dlp is not installed on the dashboard host.' : 'YouTube search could not start.')));
    child.on('close', code => {
      if (timedOut) return finish(new Error('YouTube search timed out. Try again.'));
      if (tooLarge) return finish(new Error('YouTube search returned too much data.'));
      if (code !== 0) return finish(new Error(/sign in|login|cookies/i.test(stderr)
        ? 'YouTube search needs updated yt-dlp cookies on the server.' : 'YouTube search failed. Try again.'));
      try { finish(null, normalizeResults(JSON.parse(stdout).entries)); }
      catch { finish(new Error('YouTube search returned an invalid response.')); }
    });
  });
}

module.exports = { searchYoutube, normalizeResults };
