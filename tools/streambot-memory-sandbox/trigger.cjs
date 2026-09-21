'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
require('dotenv').config({ path: process.argv[2] || path.join(__dirname, '.env') });

for (const key of ['SANDBOX_MEDIA_URL', 'WEBHOOK_SECRET', 'SBOT_GUILD_ID', 'STREAM_CHANNEL_ID']) {
  if (!String(process.env[key] || '').trim()) {
    console.error(`Missing ${key} in the sandbox .env file`);
    process.exit(2);
  }
}

const body = JSON.stringify({
  stream_url: process.env.SANDBOX_MEDIA_URL,
  guild_id: process.env.SBOT_GUILD_ID,
  channel_id: process.env.STREAM_CHANNEL_ID,
  title: 'memory-sandbox'
});
const signature = crypto.createHmac('sha256', process.env.WEBHOOK_SECRET).update(body).digest('hex');
const request = http.request({
  host: '127.0.0.1', port: Number(process.env.SANDBOX_HOST_PORT || 18081),
  path: '/webhook/stream', method: 'POST', timeout: 90000,
  headers: {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'x-webhook-secret': signature
  }
}, response => {
  let responseBody = '';
  response.on('data', chunk => { responseBody += chunk; });
  response.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(responseBody); } catch { parsed = null; }
    if (response.statusCode !== 200 || parsed?.ok !== true) {
      console.error(`Stream trigger failed: HTTP ${response.statusCode} ${responseBody}`);
      process.exit(1);
    }
    console.log('Real Discord stream started; memory observation window is active.');
  });
});
request.on('timeout', () => request.destroy(new Error('stream trigger timed out after 90 seconds')));
request.on('error', error => { console.error(error.message); process.exit(1); });
request.end(body);
