'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getShareTvScheduleHint } = require('../src/streambot/sources');
const config = { shareTvBase: 'https://tv.example', shareTvApiKey: 'must-not-send',
  shareTvAllowHosts: ['share.example'] };
const now = Math.floor(Date.now() / 1000);

async function fixture(share, run, stalled = false) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: () => stalled ? new Promise(() => {}) : Promise.resolve({ share }) };
  };
  try { await run(calls); } finally { global.fetch = original; }
}

test('ShareTV schedule hint rejects unrelated URLs without any HTTP request', async () => {
  await fixture({}, async calls => {
    for (const source of ['https://youtube.com/watch?v=abc', 'https://other.example/s/show', 'https://tv.example/api/foo', '']) {
      assert.deepEqual(await getShareTvScheduleHint(source, config), { detected: false, startAt: null });
    }
    assert.equal(calls.length, 0);
  });
});

test('ShareTV programme hint chooses earliest future programme and does not resolve media or send API keys', async () => {
  await fixture({ mode: 'programs', server_now: now, programs: [
    { id: 2, start_at: now + 300, end_at: now + 400, title: 'Later' },
    { id: 1, start_at: now + 100, end_at: now + 200, title: 'Next' },
    { id: 0, start_at: now - 100, end_at: now + 50, title: 'Current' }
  ] }, async calls => {
    assert.deepEqual(await getShareTvScheduleHint('https://share.example/s/show', config), {
      detected: true, startAt: new Date((now + 100) * 1000).toISOString(), title: 'Next'
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://tv.example/api/public/share/show');
    assert.equal(calls[0].options.headers['X-API-Key'], undefined);
    assert.equal(calls[0].options.redirect, 'error');
  });
});

test('ShareTV static event hint accepts starts_at/ends_at', async () => {
  await fixture({ kind: 'static', events: [{ starts_at: now + 100, ends_at: now + 200, title: 'Event' }] }, async () => {
    assert.equal((await getShareTvScheduleHint('show', config)).startAt, new Date((now + 100) * 1000).toISOString());
  });
});

test('ShareTV past, expired, locked, channel-only and invalid schedules never suggest a start', async () => {
  const future = [{ start_at: now + 100, end_at: now + 200 }];
  for (const share of [
    { programs: [{ start_at: now - 100, end_at: now + 100 }] },
    { ends_at: now - 1, programs: future },
    { locked: true, programs: future },
    { mode: 'channel', starts_at: now + 100, programs: future },
    { programs: [{ start_at: now + 200, end_at: now + 100 }] },
    { ends_at: now + 50, programs: future }
  ]) await fixture(share, async () => {
    assert.deepEqual(await getShareTvScheduleHint('show', config), { detected: true, startAt: null });
  });
});

test('ShareTV schedule hint bounds stalled JSON lookup and aborts the request', async () => {
  await fixture({}, async calls => {
    const started = Date.now();
    assert.deepEqual(await getShareTvScheduleHint('show', config), { detected: true, startAt: null });
    assert.ok(Date.now() - started < 2500);
    assert.equal(calls[0].options.signal.aborted, true);
  }, true);
});
