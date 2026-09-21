'use strict';

const { spawn } = require('node:child_process');
const { resolveSource } = require('/app/src/streambot/sources');

async function main() {
  const input = String(process.env.SANDBOX_MEDIA_URL || '').trim();
  if (!input || !process.env.SHARETV_BASE) throw new Error('SANDBOX_MEDIA_URL and SHARETV_BASE are required');
  let resolved = await resolveSource(input, {
    shareTvBase: process.env.SHARETV_BASE,
    ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp',
    ytdlpTimeoutMs: 30000,
    verbose: false
  });
  if (!resolved?.available || !resolved.streamUrl) {
    throw new Error(`source resolution failed: ${resolved?.note || 'no stream URL'}`);
  }
  if (process.env.DIAG_USE_HLS === 'true') {
    const base = String(process.env.SHARETV_BASE).replace(/\/+$/, '');
    const slug = /^https?:/i.test(input)
      ? new URL(input).pathname.match(/\/s\/([A-Za-z0-9_-]+)/)?.[1]
      : input;
    if (!slug) throw new Error('could not extract ShareTV slug for HLS diagnostic');
    const response = await fetch(`${base}/api/public/share/${encodeURIComponent(slug)}`);
    const body = await response.json();
    const rel = body?.share?.hls_url;
    if (!rel) throw new Error('ShareTV response has no hls_url');
    let hlsUrl = new URL(rel, base);
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(hlsUrl.hostname)) {
      const baseUrl = new URL(base);
      hlsUrl = new URL(hlsUrl.pathname + hlsUrl.search, baseUrl);
    }
    resolved = { ...resolved, streamUrl: hlsUrl.toString() };
    console.error('[diagnostic] source mode=HLS');
  }
  const parsed = new URL(resolved.streamUrl);
  console.error(`[diagnostic] resolved kind=${resolved.kind} live=${resolved.isLive === true} endpoint=${parsed.origin}${parsed.pathname}`);
  const reconnectArgs = process.env.DIAG_USE_HLS === 'true'
    ? []
    : ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_at_eof', '1', '-reconnect_delay_max', '5'];
  const args = [
    '-hide_banner', '-loglevel', 'repeat+level+verbose',
    '-thread_queue_size', '2048', '-rw_timeout', '15000000',
    '-user_agent', 'Mozilla/5.0',
    ...(process.env.DIAG_REALTIME === 'true' ? ['-re'] : []),
    ...reconnectArgs, '-i', resolved.streamUrl,
    '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-f', 'null', '-'
  ];
  async function runAttempt(attempt, limitMs, attemptArgs = args) {
    console.error(`[diagnostic] attempt=${attempt} starting with same resolved URL`);
    const ffmpeg = spawn('ffmpeg', attemptArgs, { stdio: ['ignore', 'ignore', 'inherit'] });
    const timeout = setTimeout(() => ffmpeg.kill('SIGTERM'), limitMs);
    const started = Date.now();
    const result = await new Promise((resolve, reject) => {
      ffmpeg.once('error', reject);
      ffmpeg.once('close', (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timeout);
    console.error(`[diagnostic] attempt=${attempt} closed code=${result.code} signal=${result.signal || 'none'} elapsed_s=${Math.round((Date.now() - started) / 1000)}`);
    return result;
  }

  const first = await runAttempt(1, 6 * 60 * 1000);
  if (first.code !== 0) process.exitCode = first.code || 1;
  else {
    await runAttempt(2, 30 * 1000);
    const refreshed = await resolveSource(input, {
      shareTvBase: process.env.SHARETV_BASE,
      ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp',
      ytdlpTimeoutMs: 30000,
      verbose: false
    });
    if (!refreshed?.available || !refreshed.streamUrl) throw new Error('fresh source resolution failed');
    console.error(`[diagnostic] refreshed URL changed=${refreshed.streamUrl !== resolved.streamUrl}`);
    const refreshedArgs = [...args];
    refreshedArgs[refreshedArgs.indexOf('-i') + 1] = refreshed.streamUrl;
    await runAttempt(3, 30 * 1000, refreshedArgs);
  }
}

main().catch((error) => {
  console.error(`[diagnostic] ${error.message}`);
  process.exitCode = 1;
});
