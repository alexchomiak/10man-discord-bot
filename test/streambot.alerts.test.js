'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { createAlertSink } = require('../src/streambot/alerts');
const { TAG } = require('../src/streambot/config');
const { CommandRegistry } = require('../src/streambot/commands');
const { M } = require('../src/streambot/messages');

// ============================================================================
// 1) no url / non-discord url -> log only, fetch is NEVER called
// ============================================================================
test('alerts: no url -> no fetch, only a log line', async () => {
  const logs = [];
  const fetchImpl = async () => { throw new Error('must not be called'); };
  const sink = createAlertSink({ log: (level, ...parts) => logs.push([level, parts.join(' ')]), fetchImpl });
  assert.strictEqual(sink.enabled, false);
  await assert.doesNotReject(async () => sink.notify('cmd', 'hello'));
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0][0], 'info');
  assert.ok(/cmd: hello/.test(logs[0][1]), 'the log line must carry the event + detail');
});

test('alerts: non-discord https url -> no fetch, only a log line', async () => {
  const fetchImpl = async () => { throw new Error('must not be called'); };
  const sink = createAlertSink({ url: 'https://example.com/hook', fetchImpl });
  assert.strictEqual(sink.enabled, false);
  await assert.doesNotReject(async () => sink.notify('stream-error', 'boom'));
  // http (non-https) discord url is also refused:
  const sink2 = createAlertSink({ url: 'http://discord.com/api/webhooks/1/tok', fetchImpl });
  assert.strictEqual(sink2.enabled, false);
});

// ============================================================================
// 2) discord https url -> fetch called exactly once with the exact shape
// ============================================================================
test('alerts: discord webhook url -> fetch called once with the expected body', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200 };
  };
  const url = 'https://discord.com/api/webhooks/1234567890/abcdef';
  const sink = createAlertSink({ url, fetchImpl });
  assert.strictEqual(sink.enabled, true);

  await sink.notify('stream-ended', 'Video finished (VOD ended).');
  assert.strictEqual(calls.length, 1, 'exactly one fetch call');
  assert.strictEqual(calls[0].url, url);
  assert.strictEqual(calls[0].options.method, 'POST');
  assert.strictEqual(calls[0].options.headers['content-type'], 'application/json');
  const body = JSON.parse(calls[0].options.body);
  assert.strictEqual(
    body.content,
    `${TAG} stream-ended: Video finished (VOD ended).`,
    'the body must be the exact [streambot] <event>: <detail> line'
  );

  await sink.notify('stop', 'Stopped.');
  assert.strictEqual(calls.length, 2, 'a second notify issues a second call');
});

test('alerts: redacted detail is forwarded verbatim (no double redaction)', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push(options.body); return {}; };
  const sink = createAlertSink({ url: 'https://discord.app/api/webhooks/1/tok', fetchImpl });
  await sink.notify('stream-error', 'token=*** in text');
  const body = JSON.parse(calls[0]);
  assert.ok(body.content.includes('***'), 'the (pre-redacted) detail must reach the webhook intact');
  assert.ok(!/token=[a-z]+/.test(body.content));
});

// ============================================================================
// 3) failure modes: fetch rejection / thrown signal -> notify still resolves
// ============================================================================
test('alerts: fetch rejection -> warn-logged, notify still RESOLVES', async () => {
  const logs = [];
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const sink = createAlertSink({ url: 'https://discord.com/api/webhooks/1/tok', log: (level, ...parts) => logs.push([level, parts.join(' ')]), fetchImpl });
  await assert.doesNotReject(async () => sink.notify('stream-error', 'boom'));
  const warn = logs.find((l) => l[0] === 'warn');
  assert.ok(warn, 'a warn log line must surface the webhook failure');
  assert.ok(/alert webhook failed: ECONNREFUSED/.test(warn[1]));
});

test('alerts: fetchImpl missing entirely -> log-only, still resolves', async () => {
  const deleteReal = typeof global.fetch !== 'undefined';
  const realFetch = global.fetch;
  if (deleteReal) delete global.fetch;
  try {
    const logs = [];
    const sink = createAlertSink({ url: 'https://discord.com/api/webhooks/1/tok', log: (level, ...p) => logs.push([level, p.join(' ')]) });
    assert.strictEqual(sink.enabled, true, 'the url is a valid discord webhook');
    await assert.doesNotReject(async () => sink.notify('cmd', 'ping'));
    assert.ok(logs.some((l) => l[0] === 'warn'), 'a warn (skipped) line must be logged');
  } finally {
    if (deleteReal) global.fetch = realFetch;
  }
});

// ============================================================================
// 4) AbortSignal.timeout path: Node 18+/20+ provide it; the sink must attach
//    a signal when available and stay safe when the runtime lacks it.
// ============================================================================
test('alerts: a timeout signal is attached on runtimes that have AbortSignal.timeout', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push(options); return {}; };
  const sink = createAlertSink({ url: 'https://discord.com/api/webhooks/1/tok', fetchImpl });
  await sink.notify('stop', 'done');
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    assert.ok(
      typeof calls[0].signal === 'object' && calls[0].signal instanceof AbortSignal,
      'options.signal must be an AbortSignal (3s budget) on modern runtimes'
    );
  }
});

test('alerts: a signal-less environment (fetchImpl throwing on signal) still resolves', async () => {
  // Simulate a fetch that blows up on an unexpected signal option: the sink
  // must swallow it and log, never throw.
  const logs = [];
  const fetchImpl = async (url, options) => {
    if (options && options.signal) throw new TypeError('signal unsupported');
    return {};
  };
  const sink = createAlertSink({
    url: 'https://discord.com/api/webhooks/1/tok',
    log: (level, ...p) => logs.push([level, p.join(' ')]),
    fetchImpl
  });
  await assert.doesNotReject(async () => sink.notify('cmd', 'x'));
  // Depending on runtime either the call succeeded (no signal) or it was
  // caught + warned. Both outcomes must stay exception-free.
});

// ============================================================================
// 5) commands.reply: the restricted account sends NOTHING — reply() must not
//    touch message.reply / channel.send and must forward to the alert sink
// ============================================================================
test('commands.reply: no message.reply, no channel.send; the sink receives the redacted text', async () => {
  const alerts = [];
  const sink = { notify: async (event, detail) => { alerts.push({ event, detail }); } };
  const streamManager = { config: { token: 'SECRET-TOKEN', alertSink: sink } };
  const registry = new CommandRegistry({ client: { token: 'CLIENT-TOKEN', channels: { cache: new Map() } }, streamManager });

  const sent = { reply: 0, channelSend: 0 };
  const message = {
    reply: async () => { sent.reply += 1; },
    channel: { send: async () => { sent.channelSend += 1; } }
  };

  await assert.doesNotReject(async () => registry.reply(message, M.STREAM_START_FAILED));
  assert.strictEqual(sent.reply, 0, 'message.reply must NEVER be called');
  assert.strictEqual(sent.channelSend, 0, 'channel.send must NEVER be called');
  assert.strictEqual(alerts.length, 1, 'the alert sink must receive exactly one notification');
  assert.strictEqual(alerts[0].event, 'cmd');
  assert.ok(/Failed to start the stream/.test(alerts[0].detail), 'the detail must carry the command text');
});

test('commands.reply: redacts the bot token from the forwarded detail', async () => {
  const alerts = [];
  const sink = { notify: async (event, detail) => { alerts.push({ event, detail }); } };
  const streamManager = { config: { token: 'SECRET-TOKEN', alertSink: sink } };
  const registry = new CommandRegistry({ client: {}, streamManager });
  await assert.doesNotReject(async () => registry.reply({}, `failed: login SECRET-TOKEN denied`));
  assert.strictEqual(alerts.length, 1);
  assert.ok(!alerts[0].detail.includes('SECRET-TOKEN'), 'the raw token must be redacted in the detail');
  assert.ok(alerts[0].detail.includes('***'), 'the redacted marker must replace the token');
});
