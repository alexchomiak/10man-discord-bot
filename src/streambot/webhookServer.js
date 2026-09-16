'use strict';

const http = require('http');
const crypto = require('crypto');
const { TAG, redactToken } = require('./config');

const MAX_BODY_BYTES = 64 * 1024;

function log(...parts) {
  console.log(TAG, ...parts);
}

function logError(...parts) {
  console.error(TAG, ...parts);
}

function normalizeToHex(value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return null;
  if (/^[0-9a-fA-F]{64}$/.test(v)) return v.toLowerCase();
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(v)) {
    const buf = Buffer.from(v, 'base64');
    if (buf.length === 32) return buf.toString('hex');
  }
  return null;
}

function verifySecret(secret, rawBody, provided) {
  if (typeof secret !== 'string' || !secret) return false;
  if (provided == null) return false;
  const providedStr = Array.isArray(provided) ? provided.join(',') : String(provided);
  const providedHex = normalizeToHex(providedStr);
  if (!providedHex) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(providedHex, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(Object.assign(new Error('body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

function firstString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function extractInput(payload) {
  const streamUrl = firstString(payload.stream_url);
  if (streamUrl) return streamUrl;
  const slug = firstString(payload.share_slug);
  if (slug) return slug;
  const embeds = Array.isArray(payload.embeds) ? payload.embeds : [];
  if (embeds.length) {
    const e0 = embeds[0];
    const embedded = e0 && firstString(e0 && e0.url);
    if (embedded) return embedded;
  }
  const content = firstString(payload.content);
  if (content) {
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/https?:\/\/\S+/i);
      if (m) return m[0];
    }
  }
  return null;
}

function createWebhookServer({ config, streamManager, sources }) {
  const secret = firstString(config.webhookSecret);
  if (!secret) {
    log('WARN webhookSecret unset — refusing unauthenticated stream requests; set WEBHOOK_SECRET');
  }

  function safe(str) {
    return redactToken(String(str == null ? '' : str), config.token);
  }

  function send(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  }

  function safeStatus() {
    try {
      return !!streamManager.status();
    } catch {
      return false;
    }
  }

  async function handleStream(req, res) {
    try {
      if (!secret) {
        return send(res, 503, { error: 'webhook disabled: WEBHOOK_SECRET not configured' });
      }

      let rawBody;
      try {
        rawBody = await readBody(req, MAX_BODY_BYTES);
      } catch (e) {
        return send(res, (e && e.statusCode) || 400, {
          error: e && e.statusCode === 413 ? 'request body too large' : 'could not read request body'
        });
      }

      if (!verifySecret(secret, rawBody, req.headers['x-webhook-secret'])) {
        return send(res, 401, { error: 'bad or missing x-webhook-secret' });
      }

      let payload;
      try {
        payload = JSON.parse(rawBody.toString('utf8') || 'null');
      } catch {
        return send(res, 400, { error: 'invalid JSON body' });
      }
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
        return send(res, 400, { error: 'invalid JSON body' });
      }

      const input = extractInput(payload);
      if (!input) {
        return send(res, 400, {
          error: 'no stream source: pass stream_url or share_slug (or a webhook-shaped body with a URL)'
        });
      }

      const channelId = firstString(payload.channel_id) || config.streamChannelId || '';
      const guildId = firstString(payload.guild_id) || config.guildId || '';
      // Validate targeting BEFORE resolveSource: a request with no channel
      // must not trigger a (potentially slow) yt-dlp resolve.
      if (!channelId) {
        return send(res, 400, { error: 'no target voice channel; pass channel_id or set STREAM_CHANNEL_ID' });
      }
      if (!guildId) {
        return send(res, 400, { error: 'no target guild; pass guild_id or set SBOT_GUILD_ID' });
      }

      const resolved = await sources.resolveSource(input, config);
      if (!resolved || resolved.available === false) {
        return send(res, 502, {
          ok: false,
          error: (resolved && resolved.note) || 'source unavailable',
          kind: (resolved && resolved.kind) || 'unknown'
        });
      }

      const title = firstString(payload.title) || resolved.title || '';
      const result = await streamManager.start({
        guildId,
        channelId,
        streamUrl: resolved.streamUrl || null,
        videoUrl: resolved.videoUrl || null,
        audioUrl: resolved.audioUrl || null,
        title,
        startOffsetSec: resolved.startOffsetSec || null
      });
      if (result && result.ok) {
        return send(res, 200, {
          ok: true,
          kind: resolved.kind,
          title: title || null,
          channel_id: channelId,
          note: 'streaming started'
        });
      }
      return send(res, 502, {
        ok: false,
        error: (result && result.message) || 'failed to start stream',
        kind: resolved.kind
      });
    } catch (err) {
      logError('webhook stream error:', safe(err && err.message));
      return send(res, 500, { ok: false, error: 'internal error' });
    }
  }

  function handleHealth(res) {
    send(res, 200, { ok: true, service: 'streambot', streaming: safeStatus() });
  }

  function handleHelp(res) {
    send(res, 200, {
      service: 'streambot',
      auth: 'POST /webhook/stream requires header x-webhook-secret = hex or base64 of HMAC_SHA256(WEBHOOK_SECRET, rawBody)',
      endpoints: {
        'POST /webhook/stream': {
          share_slug: 'optional ShareTV slug',
          stream_url: 'optional direct playable media URL',
          title: 'optional human title',
          guild_id: 'optional guild id override',
          channel_id: 'optional voice channel id override',
          fallback: 'also accepts a Discord-channel-webhook-shaped body (username/content/embeds[].url)'
        },
        'GET /health': 'liveness',
        'GET /webhook/help': 'this help'
      }
    });
  }

  const server = http.createServer((req, res) => {
    let path;
    let query = '';
    try {
      const u = new URL(req.url || '/', 'http://localhost');
      path = decodeURIComponent(u.pathname);
      query = u.search;
    } catch {
      path = (req.url || '/').split('?')[0];
    }

    if (path === '/health') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed; use GET' });
      return handleHealth(res);
    }
    if (path === '/webhook/help') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed; use GET' });
      return handleHelp(res);
    }
    if (path === '/webhook/stream') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed; use POST' });
      return void handleStream(req, res);
    }
    const extra = query ? `?${query}` : '';
    log(`unhandled ${req.method} ${path}${extra} — 404`);
    send(res, 404, { error: 'not found' });
  });

  server.on('clientError', (err, socket) => {
    try {
      socket.write('HTTP/1.1 400 Bad Request\r\nContent-Type: application/json; charset=utf-8\r\n\r\n{"error":"bad request"}');
      socket.end();
    } catch {}
  });

  return server;
}

module.exports = { createWebhookServer };
