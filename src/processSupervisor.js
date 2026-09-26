'use strict';

const path = require('node:path');
const { superviseChildren } = require('./superviseChildren');

const mode = process.env.MODE || 'all';
const streambotConfigured = Boolean(process.env.SELF_BOT_TOKEN || process.env.STREAMBOT_IDS);
const specs = [];
if (mode === 'bot' || mode === 'all') {
  specs.push({ name: 'CS bot', script: path.join(__dirname, 'index.js') });
}
if (mode === 'streambot' || (mode === 'all' && streambotConfigured)) {
  specs.push(...require('./streambot/supervisor').workerSpecs());
}
if (!specs.length) {
  console.error(`[launcher] no processes configured for MODE=${mode}`);
  process.exit(1);
}
superviseChildren(specs, { label: 'launcher' });
