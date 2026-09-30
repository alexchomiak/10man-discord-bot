'use strict';

// OTLP/HTTP JSON metrics. Keep at most ten seconds of samples per worker and
// never let an unavailable collector retain media-session data in memory.
function createOtlpMetrics({ endpoint, headers = '', workerId, fetchImpl = fetch,
  log = console.error, now = Date.now, sampleIntervalMs = 1000 } = {}) {
  if (!endpoint) throw new Error('STREAMBOT_OTEL_METRICS requires OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_METRICS_ENDPOINT');
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('OTLP metrics endpoint must use HTTP or HTTPS');
  if (!url.pathname.endsWith('/v1/metrics')) url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/metrics`;
  const requestHeaders = { 'content-type': 'application/json' };
  for (const entry of String(headers).split(/[,\r\n]+/)) {
    const pair = entry.trim();
    if (!pair) continue;
    // Also accept the Authorization value copied directly from OpenObserve's
    // exporter YAML. Its base64 padding can contain '=', so check first.
    const unquoted = pair.replace(/^['"]|['"]$/g, '');
    if (/^Basic\s+[A-Za-z0-9+/]+={0,2}$/i.test(unquoted)) {
      requestHeaders.Authorization = unquoted;
      continue;
    }
    const equals = pair.indexOf('=');
    const colon = pair.indexOf(':');
    const split = colon > 0 && (equals < 0 || colon < equals) ? colon : equals;
    if (split < 1) throw new Error('Invalid OTLP headers configuration (value redacted)');
    let key;
    let value;
    try {
      key = decodeURIComponent(pair.slice(0, split).trim()).toLowerCase();
      value = decodeURIComponent(pair.slice(split + 1).trim()).replace(/^['"]|['"]$/g, '');
    } catch {
      throw new Error('Invalid OTLP headers encoding (value redacted)');
    }
    if (key !== 'authorization' && key !== 'stream-name') {
      throw new Error('Unsupported OTLP header (name and value redacted)');
    }
    requestHeaders[key] = value;
  }
  let samples = [];
  const maxSamples = Math.ceil(10000 / ([250, 500, 1000].includes(sampleIntervalMs) ? sampleIntervalMs : 1000));
  let inFlight = false;
  let lastWarning = 0;
  function warn(message) {
    const time = now();
    if (time - lastWarning < 60000) return;
    lastWarning = time;
    // Never include the URL, request headers, response body, or credentials.
    log(`OTLP metrics export failed: ${message}`);
  }
  function record(values) {
    const metrics = Object.fromEntries(Object.entries(values || {}).filter(([key, value]) =>
      /^[a-z][a-z0-9_]*$/.test(key) && Number.isFinite(value)));
    if (!Object.keys(metrics).length) return;
    samples.push({ timeUnixNano: String(BigInt(now()) * 1000000n), metrics });
    if (samples.length > maxSamples) samples.shift();
    if (samples.length >= maxSamples) void flush();
  }
  async function flush() {
    if (inFlight || !samples.length) return;
    const batch = samples;
    samples = [];
    inFlight = true;
    const names = [...new Set(batch.flatMap(sample => Object.keys(sample.metrics)))];
    const body = { resourceMetrics: [{
      resource: { attributes: [
        { key: 'service.name', value: { stringValue: '10man-streambot' } },
        { key: 'streambot.worker.id', value: { stringValue: String(workerId || 'primary') } }
      ] },
      scopeMetrics: [{ scope: { name: '10man.streambot' }, metrics: names.map(name => ({
        name: `streambot.${name}`,
        gauge: { dataPoints: batch.filter(sample => name in sample.metrics).map(sample => ({
          timeUnixNano: sample.timeUnixNano, asDouble: sample.metrics[name]
        })) }
      })) }]
    }] };
    try {
      const response = await fetchImpl(url, {
        method: 'POST', headers: requestHeaders, body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000)
      });
      if (!response.ok) warn(`HTTP ${response.status}`);
    } catch (error) {
      warn(error?.name === 'TimeoutError' ? 'timeout' : 'network error');
    } finally {
      inFlight = false;
    }
  }
  const timer = setInterval(() => { void flush(); }, 10000);
  timer.unref?.();
  return { record, flush };
}

module.exports = { createOtlpMetrics };
