'use strict';

const { createHash } = require('node:crypto');

const base = String(process.env.SHARETV_BASE || '').replace(/\/+$/, '');
const input = String(process.env.SANDBOX_MEDIA_URL || '').trim();

function digest(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function slugFrom(value) {
  if (!/^https?:/i.test(value)) return value;
  return new URL(value).pathname.match(/\/s\/([A-Za-z0-9_-]+)/)?.[1] || '';
}

function describeUrl(value) {
  if (!value) return null;
  const url = new URL(value, base);
  return {
    path: url.pathname,
    queryKeys: [...url.searchParams.keys()].sort(),
    fingerprint: digest(url.toString())
  };
}

async function snapshot(index) {
  const slug = slugFrom(input);
  const response = await fetch(`${base}/api/public/share/${encodeURIComponent(slug)}`, { cache: 'no-store' });
  const body = await response.json();
  const share = body?.share || {};
  const safe = {};
  for (const [key, value] of Object.entries(share)) {
    if (/(?:url|token|viewer|sig|secret|key)/i.test(key)) continue;
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) safe[key] = value;
  }
  console.log(JSON.stringify({
    index,
    status: response.status,
    safe,
    stream: describeUrl(share.stream_url),
    hls: describeUrl(share.hls_url),
    media: describeUrl(share.media_url)
  }));
  return share;
}

async function main() {
  if (!base || !input) throw new Error('SHARETV_BASE and SANDBOX_MEDIA_URL are required');
  let latest;
  for (let index = 1; index <= 3; index += 1) {
    latest = await snapshot(index);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (process.env.DIAG_PROBE_STREAM === 'true' && latest?.stream_url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let bytes = 0;
    try {
      const response = await fetch(new URL(latest.stream_url, base), { signal: controller.signal });
      if (response.ok && response.body) {
        for await (const chunk of response.body) bytes += chunk.length;
      }
      console.log(JSON.stringify({ probeStatus: response.status, probeBytes: bytes }));
    } catch (error) {
      console.log(JSON.stringify({ probeError: error.name, probeBytes: bytes }));
    } finally {
      clearTimeout(timer);
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
