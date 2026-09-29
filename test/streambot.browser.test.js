'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const browserStream = require('../src/streambot/browserStream');
const { resolveSource } = require('../src/streambot/sources');

test('yt-dlp failure falls back to a browser playable page', async () => {
  const original = browserStream.probeBrowser;
  const url = 'https://example.com/event';
  let probed = false;
  browserStream.probeBrowser = async input => {
    probed = true;
    assert.equal(input, url);
    return { available: true, kind: 'browser', title: 'Live Stream',
      browserPageUrl: input, streamUrl: input, isLive: true };
  };
  try {
    const result = await resolveSource(url, { ytdlpPath: '/nonexistent/yt-dlp', browserFallback: true });
    assert.equal(probed, true);
    assert.equal(result.kind, 'browser');
    assert.equal(result.title, 'Live Stream');
  } finally { browserStream.probeBrowser = original; }
});

test('headless browser captures HTML5 video into a playable local WebM feed',
  { skip: !fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') &&
      !fs.existsSync('/usr/bin/chromium-headless-shell') }, async t => {
    const fixture = `<!doctype html><video width="320" height="180" autoplay playsinline></video>
<script>
const canvas = document.createElement('canvas');
canvas.width = 320; canvas.height = 180;
const ctx = canvas.getContext('2d'); let frame = 0;
setInterval(() => { ctx.fillStyle = frame++ % 2 ? 'red' : 'blue'; ctx.fillRect(0, 0, 320, 180); }, 33);
const audio = new AudioContext(); const oscillator = audio.createOscillator();
const destination = audio.createMediaStreamDestination();
oscillator.connect(destination); oscillator.start(); audio.resume();
const stream = canvas.captureStream(30);
destination.stream.getAudioTracks().forEach(track => stream.addTrack(track));
document.querySelector('video').srcObject = stream;
document.querySelector('video').play();
</script>`;
    const server = http.createServer((_, res) => res.end(fixture));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/player`;
    const config = { browserTimeoutMs: 10000, streamWidth: 320, streamHeight: 180 };
    const probed = await browserStream.probeBrowser(url, config);
    assert.equal(probed?.title, 'Live Stream');
    const controller = new AbortController();
    const capture = await browserStream.startBrowserStream(url, config, controller.signal);
    t.after(() => capture.stop());
    const response = await fetch(capture.url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /video\/webm/);
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    const deadline = Date.now() + 8000;
    while (bytes < 16000 && Date.now() < deadline) {
      let timer;
      const { value, done } = await Promise.race([
        reader.read(), new Promise((_, reject) => { timer = setTimeout(() =>
          reject(new Error('No WebM data')), 8000); })
      ]).finally(() => clearTimeout(timer));
      if (done) break;
      chunks.push(Buffer.from(value));
      bytes += value.length;
    }
    await reader.cancel();
    assert(bytes > 0);
    const ffprobe = spawn('ffprobe', ['-v', 'error', '-show_entries',
      'stream=codec_type', '-of', 'csv=p=0', 'pipe:0']);
    ffprobe.stdin.end(Buffer.concat(chunks));
    let output = '';
    let errors = '';
    ffprobe.stdout.on('data', chunk => { output += chunk; });
    ffprobe.stderr.on('data', chunk => { errors += chunk; });
    const code = await new Promise(resolve => ffprobe.on('close', resolve));
    assert.equal(code, 0, `bytes=${bytes} header=${Buffer.concat(chunks).subarray(0, 16).toString('hex')} ${errors}`);
    assert.match(output, /video/);
    assert.match(output, /audio/);
    controller.abort();
  });
