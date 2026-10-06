'use strict';

// Run inside the playback container so its VPN, DNS, and source configuration
// match the failing worker. No Discord connection or hardware decoder is used.
const { spawn } = require('node:child_process');
const { loadConfig, redactToken } = require('../src/streambot/config');
const { resolveSource, isYoutubeHlsUrl } = require('../src/streambot/sources');

function sanitize(value, token) {
  return redactToken(String(value || ''), token)
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL]')
    .replace(/^.*(?:cookie|authorization|proxy-authorization)\s*:.*$/gim, '[REDACTED HEADER]')
    .slice(-2048);
}

function run(bin, args, timeoutMs = 20000) {
  return new Promise(resolve => {
    let stderr = '';
    let stdout = '';
    let timedOut = false;
    let timer;
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const capture = (previous, chunk) => {
      const text = previous + chunk;
      if (text.length <= 8192) return text;
      // Drop the entire truncated leading line so a cut URL cannot evade
      // redaction by losing its https:// prefix.
      const tail = text.slice(-8192);
      const newline = tail.indexOf('\n');
      return newline < 0 ? '' : tail.slice(newline + 1);
    };
    child.stdout.on('data', chunk => { stdout = capture(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = capture(stderr, chunk); });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ ok: false, stderr: error.message, code: null, timedOut });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, timedOut, stdout, stderr });
    });
    timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  });
}

function inputArgs(url, config) {
  const options = isYoutubeHlsUrl(url) ? ['-extension_picky', '0'] : [];
  options.push('-thread_queue_size', '256', '-rw_timeout',
    String(Math.max(1000, Math.round((config.ffmpegReadTimeoutMs || 15000) * 1000))),
    '-user_agent', 'Mozilla/5.0', '-readrate', '1.15', '-readrate_initial_burst', '4');
  if (!/m3u8?/i.test(url)) options.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  return ['-hide_banner', '-loglevel', 'error', ...options, '-i', url,
    '-t', '1', '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-f', 'null', '-'];
}

async function main() {
  require('dotenv').config({ quiet: true });
  const url = process.argv[2];
  if (!url || !/^https:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//i.test(url)) {
    throw new Error('Usage: node scripts/diagnose-youtube-input.cjs <public YouTube URL>');
  }
  // loadConfig validates a Discord token, although this command never uses it.
  const savedToken = process.env.SELF_BOT_TOKEN;
  if (!savedToken) process.env.SELF_BOT_TOKEN = 'source-diagnostic-no-login';
  let config;
  try { config = loadConfig(); }
  finally {
    if (savedToken === undefined) delete process.env.SELF_BOT_TOKEN;
    else process.env.SELF_BOT_TOKEN = savedToken;
  }
  config = { ...config, verbose: false, browserFallback: false, ytdlpTimeoutMs: 20000 };
  const print = value => console.log(sanitize(value, savedToken));
  const version = await run(config.ffmpegPath, ['-version'], 5000);
  print((version.stdout || version.stderr).split('\n')[0]);
  const source = await resolveSource(url, config);
  print(`resolver=${source.kind} available=${source.available} streamType=${source.streamType || 'none'}`);
  if (!source.available) throw new Error(source.note || 'Source unavailable');
  const inputs = source.streamType === 'dash'
    ? [['video', source.videoUrl], ['audio', source.audioUrl]]
    : [['combined', source.streamUrl]];
  for (const [role, input] of inputs) {
    const parsed = new URL(input);
    print(`input=${role} protocol=${isYoutubeHlsUrl(input) ? 'HLS' : parsed.protocol.replace(':', '')} host=${parsed.hostname}`);
    const started = Date.now();
    const result = await run(config.ffmpegPath, inputArgs(input, config));
    print(`input=${role} ok=${result.ok} exit=${result.code} timeout=${result.timedOut} elapsed_ms=${Date.now() - started}`);
    if (!result.ok) {
      print(result.stderr || 'FFmpeg returned no diagnostic text');
      process.exitCode = 1;
    }
  }
}

if (require.main === module) main().catch(error => {
  console.error(sanitize(error.message, process.env.SELF_BOT_TOKEN));
  process.exitCode = 1;
});
module.exports = { sanitize, run, inputArgs };
