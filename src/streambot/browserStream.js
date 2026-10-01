'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { chromium } = require('playwright-core');

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function browserOptions(config = {}) {
  const executablePath = config.browserPath || (process.platform === 'linux' ? '/usr/bin/chromium-headless-shell' : undefined);
  return {
    ...(executablePath ? { executablePath } : { channel: 'chrome' }),
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage']
  };
}

function validPageUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

function probeFailureKind(error) {
  const message = String(error?.message || '');
  if (message.includes('No visible HTML5 video player')) return 'no-visible-video';
  if (message.includes('did not start video playback')) return 'video-not-playing';
  if (error?.name === 'TimeoutError' || /timeout/i.test(message)) return 'timeout';
  return 'browser-error';
}

async function findVideo(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const videos = frame.locator('video');
        const count = Math.min(await videos.count(), 5);
        for (let index = 0; index < count; index++) {
          const video = videos.nth(index);
          const visible = await video.evaluate(element => {
            const box = element.getBoundingClientRect();
            return box.width >= 160 && box.height >= 90;
          });
          if (visible) return { frame, video };
        }
      } catch { /* A frame may navigate while the player loads. */ }
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('No visible HTML5 video player appeared.');
}

async function playVideo({ frame, video }, timeoutMs) {
  const selectors = ['.jw-icon-display', '.player-poster', '[aria-label="Play"]', '[data-poster]'];
  for (const selector of selectors) {
    const control = frame.locator(selector).first();
    if (await control.count().catch(() => 0)) {
      await control.click({ force: true, timeout: 2000 }).catch(() => {});
      break;
    }
  }
  await video.evaluate(element => element.play().catch(() => {})).catch(() => {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await video.evaluate(element => ({
      ready: element.readyState >= 2 && element.videoWidth > 0,
      playing: !element.paused && element.currentTime > 0.25,
      width: element.videoWidth,
      height: element.videoHeight
    })).catch(() => null);
    if (state?.ready && state.playing) return state;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('The browser player did not start video playback.');
}

async function openPlayer(pageUrl, config = {}) {
  if (!validPageUrl(pageUrl)) throw new Error('Browser fallback requires an HTTP(S) page URL.');
  const timeoutMs = Number(config.browserTimeoutMs) || DEFAULT_TIMEOUT_MS;
  const browser = await chromium.launch(browserOptions(config));
  try {
    const context = await browser.newContext({ viewport: {
      width: Number(config.streamWidth) || 1920,
      height: Number(config.streamHeight) || 1080
    } });
    const page = await context.newPage();
    page.on('popup', popup => { void popup.close().catch(() => {}); });
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const player = await findVideo(page, timeoutMs);
    const state = await playVideo(player, timeoutMs);
    return { browser, page, player, state };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

async function probeBrowser(pageUrl, config = {}) {
  if (!validPageUrl(pageUrl) || config.browserFallback === false) return null;
  let opened;
  try {
    opened = await openPlayer(pageUrl, config);
    const tracks = await opened.player.video.evaluate(video => {
      if (typeof video.captureStream !== 'function' || typeof MediaRecorder === 'undefined') return null;
      const stream = video.captureStream();
      const kinds = stream.getTracks().map(track => track.kind);
      stream.getTracks().forEach(track => track.stop());
      return kinds;
    });
    if (!tracks?.includes('video')) {
      if (config.verbose === true) console.log('[streambot]', 'Chromium probe failed: video-not-capturable');
      return null;
    }
    return { kind: 'browser', available: true, browserPageUrl: pageUrl,
      streamUrl: pageUrl, title: 'Live Stream', isLive: true,
      totalDurationSec: null, note: 'HTML5 video captured in a headless browser' };
  } catch (error) {
    if (config.verbose === true) console.log('[streambot]', `Chromium probe failed: ${probeFailureKind(error)}`);
    return null;
  }
  finally { await opened?.browser.close().catch(() => {}); }
}

async function startBrowserStream(pageUrl, config = {}, signal) {
  if (signal?.aborted) throw new Error('Browser stream cancelled.');
  const opened = await openPlayer(pageUrl, config);
  const { browser, page, player } = opened;
  if (signal?.aborted) {
    await browser.close().catch(() => {});
    throw new Error('Browser stream cancelled.');
  }
  const token = crypto.randomBytes(16).toString('hex');
  const bindingName = `__streamChunk_${token}`;
  let response = null;
  let buffered = [];
  let bufferedBytes = 0;
  let stopped = false;
  let firstChunkResolve;
  const firstChunk = new Promise(resolve => { firstChunkResolve = resolve; });
  let server;
  let stopPromise;
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopped = true;
    signal?.removeEventListener('abort', abort);
    firstChunkResolve();
    stopPromise = (async () => {
      response?.destroy();
      if (server?.listening) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
      await browser.close().catch(() => {});
    })();
    return stopPromise;
  };
  const abort = () => { void stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    server = http.createServer((request, res) => {
      if (request.method !== 'GET' || request.url !== `/${token}/capture.webm` || response) {
        res.writeHead(404).end();
        return;
      }
      response = res;
      res.writeHead(200, { 'Content-Type': 'video/webm', 'Cache-Control': 'no-store' });
      for (const chunk of buffered) res.write(chunk);
      buffered = [];
      bufferedBytes = 0;
      res.on('close', () => { response = null; if (!stopped) void stop(); });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    if (stopped) {
      await new Promise(resolve => server.close(resolve));
      throw new Error('Browser stream cancelled.');
    }
    await page.exposeBinding(bindingName, async ({ frame }, payload) => {
      if (stopped || frame !== player.frame || typeof payload !== 'string') return;
      if (payload.length > MAX_CHUNK_BYTES * 4 / 3 + 100) { void stop(); return; }
      const chunk = Buffer.from(payload, 'base64');
      if (chunk.length > MAX_CHUNK_BYTES) { void stop(); return; }
      if (response) {
        if (response.writableLength > MAX_BUFFER_BYTES) { void stop(); return; }
        response.write(chunk);
      } else {
        bufferedBytes += chunk.length;
        if (bufferedBytes > MAX_BUFFER_BYTES) { void stop(); return; }
        buffered.push(chunk);
      }
      firstChunkResolve();
    });
    const capture = await player.video.evaluate((video, name) => {
      const stream = video.captureStream();
      const tracks = stream.getTracks();
      if (!tracks.some(track => track.kind === 'video')) {
        tracks.forEach(track => track.stop());
        return { ok: false, error: 'No capturable video track.' };
      }
      const mime = ['video/webm;codecs=vp8,opus', 'video/webm']
        .find(value => MediaRecorder.isTypeSupported(value));
      if (!mime) return { ok: false, error: 'WebM recording is unavailable.' };
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      recorder.ondataavailable = async event => {
        if (!event.data.size) return;
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split('base64,')[1]);
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(event.data);
        });
        await window[name](data);
      };
      recorder.start(1000);
      return { ok: true, audio: tracks.some(track => track.kind === 'audio'), mime };
    }, bindingName);
    if (!capture.ok) throw new Error(capture.error);
    let chunkTimeout;
    try {
      await Promise.race([
        firstChunk,
        new Promise((_, reject) => { chunkTimeout = setTimeout(() =>
          reject(new Error('Browser produced no media chunks.')),
        Number(config.browserTimeoutMs) || DEFAULT_TIMEOUT_MS); })
      ]);
    } finally { clearTimeout(chunkTimeout); }
    if (stopped) throw new Error('Browser stream stopped before media became available.');
    return { url: `http://127.0.0.1:${server.address().port}/${token}/capture.webm`,
      hasAudio: capture.audio, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

module.exports = { probeBrowser, startBrowserStream, validPageUrl, browserOptions };
