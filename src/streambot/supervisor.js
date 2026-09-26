'use strict';

const path = require('node:path');
const { superviseChildren } = require('../superviseChildren');

function suffix(id) { return id.toUpperCase().replace(/-/g, '_'); }

function workerSpecs() {
  const rawIds = String(process.env.STREAMBOT_IDS || '').split(',').map(value => value.trim()).filter(Boolean);
  const defaultWorkerId = String(process.env.STREAMBOT_DEFAULT_ID || 'primary').trim() || 'primary';
  const ids = rawIds.length ? rawIds : [String(process.env.STREAMBOT_ID || defaultWorkerId).trim() || defaultWorkerId];
  const normalized = new Set();
  const tokens = new Set();
  const specs = [];
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
    const chatCommands = scopedChat ?? inheritedChat ?? (id.toLowerCase() === defaultWorkerId.toLowerCase() ? 'true' : 'false');
    specs.push({
      name: `worker '${id}'`,
      script: path.join(__dirname, 'index.js'),
      env: { STREAMBOT_ID: id, SELF_BOT_TOKEN: token, SBOT_CHAT_COMMANDS: chatCommands }
    });
  }
  return specs;
}

if (require.main === module) superviseChildren(workerSpecs(), { label: 'streambot-supervisor' });

module.exports = { workerSpecs };
