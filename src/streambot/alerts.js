'use strict';

// Outbound alert sink.
//
// The bot account is restricted and can NO LONGER send channel messages, so
// every success/error feedback point logs locally AND (optionally) POSTs to a
// regular Discord server webhook configured via TELEMETRY_WEBHOOK_URL.
//
// Contract for notify(event, detail):
//   * fire-and-forget safe: ALWAYS resolves, NEVER throws, NEVER blocks;
//   * detail MUST be pre-redacted by the caller (redactToken / _sanitize);
//   * no url, or a url that is not an https://discord… webhook -> log only.
const { TAG } = require('./config');

function defaultLog(level, ...parts) {
  if (level === 'error') console.error(TAG, ...parts);
  else if (level === 'warn') console.warn(TAG, ...parts);
  else console.log(TAG, ...parts);
}

function isDiscordWebhookUrl(url) {
  try {
    const u = new URL(String(url).trim());
    return u.protocol === 'https:' && /(^|\.)discord\.(com|app)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

function maybeTimeoutSignal() {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(3000);
    }
  } catch { /* custom fetchImpl / older runtime — call without a signal */ }
  return undefined;
}

function createAlertSink({ url, log, fetchImpl } = {}) {
  const logFn = typeof log === 'function' ? log : defaultLog;
  let fetchFn = typeof fetchImpl === 'function' ? fetchImpl : null;
  if (typeof fetchFn !== 'function') {
    try {
      if (typeof fetch === 'function') fetchFn = (u, o) => fetch(u, o);
    } catch { /* no fetch at all -> log-only */ }
  }
  const trimmed = (url || '').trim();
  const target = trimmed && isDiscordWebhookUrl(trimmed) ? trimmed : null;

  async function notify(event, detail) {
    const text = `${String(event || '')}: ${detail == null ? '' : String(detail)}`;
    if (!target) {
      try { logFn('info', `(no-send) ${text}`); } catch { /* noop */ }
      return;
    }
    if (typeof fetchFn !== 'function') {
      try { logFn('warn', `alert webhook skipped (no fetch available): ${text}`); } catch { /* noop */ }
      return;
    }
    try {
      const options = {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: `${TAG} ${text}` })
      };
      const signal = maybeTimeoutSignal();
      if (signal) options.signal = signal;
      await fetchFn(target, options);
    } catch (e) {
      try { logFn('warn', `alert webhook failed: ${(e && e.message) || e}`); } catch { /* noop */ }
    }
  }

  return { notify, enabled: !!target, url: target };
}

module.exports = { createAlertSink };
