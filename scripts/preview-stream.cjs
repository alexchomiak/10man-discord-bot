#!/usr/bin/env node
'use strict';

// Local playback smoke test using the same resolver and browser capture as
// queue playback. No Discord login or token is needed.
require('dotenv').config();
const { spawn } = require('node:child_process');
const { loadConfig } = require('../src/streambot/config');
const { resolveSource } = require('../src/streambot/sources');
const { startBrowserStream } = require('../src/streambot/browserStream');

const pageUrl = process.argv[2];
if (!pageUrl || process.argv.length > 3) {
  console.error('Usage: node scripts/preview-stream.cjs <page-or-stream-url>');
  process.exit(2);
}

// loadConfig supplies the production resolver settings. Its token requirement
// is unrelated to this local preview; do not use the placeholder for a login.
process.env.SELF_BOT_TOKEN ||= 'local-preview-only';
const config = loadConfig();
const controller = new AbortController();
let capture;
let player;
let merger;
let stopping = false;

function stop() {
  if (stopping) return;
  stopping = true;
  controller.abort();
  player?.kill('SIGTERM');
  merger?.kill('SIGTERM');
  void capture?.stop();
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

function launch(binary, args, stdio) {
  const child = spawn(binary, args, { stdio });
  child.on('error', error => {
    console.error(`${binary}: ${error.message}`);
    process.exitCode = 1;
    stop();
  });
  return child;
}

async function main() {
  console.log(`Resolving ${pageUrl}`);
  const source = await resolveSource(pageUrl, config);
  if (stopping) return;
  if (!source?.available || source.kind === 'youtube-playlist') {
    throw new Error(source?.note || 'The URL has no playable stream.');
  }
  console.log(`Resolver: ${source.kind}; title: ${source.title || 'Untitled'}`);
  if (source.browserPageUrl) {
    capture = await startBrowserStream(source.browserPageUrl, config, controller.signal);
    if (stopping) return;
    console.log(`Browser capture ready (${capture.hasAudio ? 'video + audio' : 'video only'}). Opening ffplay…`);
    player = launch(process.env.FFPLAY_PATH || 'ffplay',
      ['-loglevel', 'warning', '-autoexit', '-i', capture.url], 'inherit');
  } else if (source.videoUrl && source.audioUrl) {
    console.log('Opening resolved video + audio in ffplay…');
    merger = launch(config.ffmpegPath || 'ffmpeg', ['-loglevel', 'error',
      '-i', source.videoUrl, '-i', source.audioUrl,
      '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-f', 'nut', 'pipe:1'],
    ['ignore', 'pipe', 'inherit']);
    player = launch(process.env.FFPLAY_PATH || 'ffplay',
      ['-loglevel', 'warning', '-autoexit', '-i', 'pipe:0'], ['pipe', 'inherit', 'inherit']);
    merger.stdout.pipe(player.stdin);
  } else if (source.streamUrl) {
    console.log('Opening resolved stream in ffplay…');
    player = launch(process.env.FFPLAY_PATH || 'ffplay',
      ['-loglevel', 'warning', '-autoexit', '-i', source.streamUrl], 'inherit');
  } else {
    throw new Error('The resolver returned no playable media URL.');
  }
  const exitCode = await new Promise(resolve => player.once('close', resolve));
  if (exitCode && !stopping) process.exitCode = exitCode;
}

main().catch(error => {
  if (!stopping) {
    console.error(error.message);
    process.exitCode = 1;
  }
}).finally(async () => {
  stop();
  await capture?.stop();
});
