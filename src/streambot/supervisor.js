'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const rawIds = String(process.env.STREAMBOT_IDS || '').split(',').map(value => value.trim()).filter(Boolean);
const ids = rawIds.length ? rawIds : [String(process.env.STREAMBOT_ID || 'primary').trim() || 'primary'];
const normalized = new Set();
const tokens = new Set();
const workers = [];
let stopping = false;

function suffix(id) { return id.toUpperCase().replace(/-/g, '_'); }

for (const id of ids) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error(`Invalid STREAMBOT_ID '${id}'.`);
  const key = suffix(id);
  if (normalized.has(key)) throw new Error(`Worker IDs collide after env normalization: ${id}`);
  normalized.add(key);
  const scopedToken = process.env[`SELF_BOT_TOKEN_${key}`];
  const token = scopedToken || (ids.length === 1 ? process.env.SELF_BOT_TOKEN : '');
  if (!token) throw new Error(`Missing SELF_BOT_TOKEN_${key} for streambot '${id}'.`);
  if (tokens.has(token)) throw new Error(`Streambot '${id}' reuses another worker's Discord token.`);
  tokens.add(token);
  const scopedChat = process.env[`SBOT_CHAT_COMMANDS_${key}`];
  const inheritedChat = process.env.SBOT_CHAT_COMMANDS;
  const chatCommands = scopedChat ?? inheritedChat ?? (id === 'primary' ? 'true' : 'false');
  const child = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    stdio: 'inherit',
    env: { ...process.env, STREAMBOT_ID: id, SELF_BOT_TOKEN: token, SBOT_CHAT_COMMANDS: chatCommands }
  });
  workers.push({ id, child });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`[streambot-supervisor] ${id} exited code=${code} signal=${signal || 'none'}`);
    shutdown('SIGTERM', code || 1);
  });
}

function shutdown(signal, exitCode) {
  if (stopping) return;
  stopping = true;
  for (const { child } of workers) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
  const timer = setTimeout(() => {
    for (const { child } of workers) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    process.exit(exitCode);
  }, 5000);
  timer.unref?.();
  Promise.all(workers.map(({ child }) => (
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise(resolve => child.once('exit', resolve))
  )))
    .finally(() => process.exit(exitCode));
}

process.on('SIGINT', () => shutdown('SIGINT', 130));
process.on('SIGTERM', () => shutdown('SIGTERM', 143));

console.log(`[streambot-supervisor] started workers: ${ids.join(', ')}`);
