'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { probeBrowser, probeFailureKind } = require('../src/streambot/browserStream');

function browserFixture(t, { status = 200, tracks = ['video'], navigationError, noVideo = false } = {}) {
  let closed = 0;
  const contextOptions = [];
  const logs = [];
  t.mock.method(console, 'log', (...parts) => logs.push(parts.join(' ')));
  const video = { evaluate: async fn => {
    const code = String(fn);
    if (code.includes('getBoundingClientRect')) return true;
    if (code.includes('captureStream')) return tracks;
    if (code.includes('readyState')) return { ready: true, playing: true, width: 320, height: 180 };
  } };
  const control = { count: async () => 0 };
  control.first = () => control;
  const frame = { locator: selector => selector === 'video'
    ? { count: async () => 1, nth: () => video } : control };
  const page = { on: () => {}, frames: () => noVideo ? [] : [frame], goto: async () => {
    if (navigationError) throw navigationError;
    return { status: () => status };
  } };
  t.mock.method(chromium, 'launch', async () => ({ close: async () => { closed++; },
    newContext: async options => { contextOptions.push(options); return { newPage: async () => page }; } }));
  return { logs, contextOptions, closed: () => closed };
}

test('Chromium HTTP access denial returns actionable failure and logs safely even without verbose', async t => {
  const h = browserFixture(t, { status: 403, noVideo: true });
  const result = await probeBrowser('https://example.com/event?token=private', { browserTimeoutMs: 1 });
  assert.equal(result.available, false);
  assert.equal(result.failureKind, 'access-denied');
  assert.match(result.note, /yt-dlp.*Chromium.*denied/);
  assert.equal(h.closed(), 1);
  assert.equal(h.logs.length, 1);
  assert.ok(!JSON.stringify([result, h.logs]).includes('private'));
});

test('Chromium navigation and HTTP errors are distinct and omit raw browser diagnostics', async t => {
  const h = browserFixture(t, { navigationError: new Error('net::ERR_CERT_AUTHORITY_INVALID https://user:secret@example.com') });
  const result = await probeBrowser('https://example.com');
  assert.equal(result.failureKind, 'navigation-error');
  assert.ok(!JSON.stringify([result, h.logs]).includes('secret'));
  assert.equal(h.closed(), 1);
});

test('uncapturable player reports browser failure instead of a successful source', async t => {
  const h = browserFixture(t, { tracks: ['audio'] });
  const result = await probeBrowser('https://example.com');
  assert.equal(result.available, false);
  assert.equal(result.failureKind, 'video-not-capturable');
  assert.equal(h.closed(), 1);
  assert.equal(h.logs.length, 1);
});

test('browser launch failure, missing video, playback and timeout have stable safe categories', async t => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(chromium, 'launch', async () => { throw new Error("browserType.launch: Executable doesn't exist /private/secret"); });
  const result = await probeBrowser('https://example.com');
  assert.equal(result.failureKind, 'browser-unavailable');
  assert.match(result.note, /STREAMBOT_BROWSER_PATH/);
  assert.ok(!result.note.includes('/private'));
  for (const [message, expected] of [
    ['No visible HTML5 video player appeared.', 'no-visible-video'],
    ['The browser player did not start video playback.', 'video-not-playing'],
    ['Browser page returned HTTP error.', 'page-unavailable'],
    ['navigation timed out: private', 'timeout'], ['unknown private error', 'browser-error']
  ]) assert.equal(probeFailureKind(new Error(message)), expected);
});


test('HTTP error status does not reject an otherwise usable embedded player', async t => {
  const h = browserFixture(t, { status: 403 });
  const result = await probeBrowser('https://example.com');
  assert.equal(result.available, true);
  assert.equal(h.logs.length, 0);
  assert.equal(h.closed(), 1);
});


test('browser User-Agent override reaches the shared probe/capture context while default remains untouched', async t => {
  const h = browserFixture(t);
  const original = await probeBrowser('https://example.com');
  assert.equal(original.available, true);
  assert.equal(Object.hasOwn(h.contextOptions[0], 'userAgent'), false);
  const overridden = await probeBrowser('https://example.com', { browserUserAgent: '  Normal Chrome identifier  ' });
  assert.equal(overridden.available, true);
  assert.equal(h.contextOptions[1].userAgent, 'Normal Chrome identifier');
  assert.deepEqual(h.contextOptions[1].viewport, h.contextOptions[0].viewport);
});

test('browser User-Agent config trims values, defaults empty, rejects header controls and excess length', t => {
  const { loadConfig, parseBrowserUserAgent } = require('../src/streambot/config');
  const originalToken = process.env.SELF_BOT_TOKEN;
  const originalAgent = process.env.STREAMBOT_BROWSER_USER_AGENT;
  t.after(() => {
    if (originalToken === undefined) delete process.env.SELF_BOT_TOKEN; else process.env.SELF_BOT_TOKEN = originalToken;
    if (originalAgent === undefined) delete process.env.STREAMBOT_BROWSER_USER_AGENT; else process.env.STREAMBOT_BROWSER_USER_AGENT = originalAgent;
  });
  process.env.SELF_BOT_TOKEN = 'test';
  delete process.env.STREAMBOT_BROWSER_USER_AGENT;
  assert.equal(loadConfig().browserUserAgent, '');
  process.env.STREAMBOT_BROWSER_USER_AGENT = '  Normal Chrome identifier  ';
  assert.equal(loadConfig().browserUserAgent, 'Normal Chrome identifier');
  for (const value of ['Chrome\r\nAuthorization: private', 'Chrome\u0000', 'Chrome\t', 'x'.repeat(1025), {}]) {
    assert.throws(() => parseBrowserUserAgent(value), /STREAMBOT_BROWSER_USER_AGENT/);
  }
});
