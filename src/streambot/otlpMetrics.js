'use strict';

// OTLP/HTTP JSON metrics. Keep only ten 1 Hz samples per worker and never
// let an unavailable collector retain media-session data in memory.
function createOtlpMetrics({ endpoint, headers = '', workerId, fetchImpl = fetch,
  log = console.error, now = Date.now } = {}) {
  if (!endpoint) throw new Error('STREAMBOT_OTEL_METRICS requires OTEL_EXPORTER_OTLP_ENDPOINT or OTEL_EXPORTER_OTLP_METRICS_ENDPOINT');
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('OTLP metrics endpoint must use HTTP or HTTPS');
  if (!url.pathname.endsWith('/v1/metrics')) url.pathname = `${url.pathname.replace(/\/+$/, '')}/v1/metrics`;
  const requestHeaders = { 'content-type': 'application/json' };
  for (const pair of String(headers).split(',')) {
    if (!pair.trim()) continue;
    const split = pair.indexOf('=');
    if (split < 1) throw new Error('Invalid OTEL_EXPORTER_OTLP_HEADERS entry');
    const key = decodeURIComponent(pair.slice(0, split).trim());
    const value = decodeURIComponent(pair.slice(split + 1).trim());
    if (!/^(authorization|stream-name)$/i.test(key)) throw new Error(`Unsupported OTLP header: ${key}`);
    requestHeaders[key] = value;
  }
  let samples = [];
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
    if (samples.length > 10) samples.shift();
    if (samples.length >= 10) void flush();
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
