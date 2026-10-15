'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveShareTv } = require('../src/streambot/sources');
const base = 'https://tv.example';
const share = { stream_available: true, stream_url: '/api/public/stream/test',
  server_now: 100, icon_url: '/channel.jpg' };

async function resolve(payload, previewResponse, key) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/api/public/share/')) return { status: 200, ok: true, json: async () => ({ share: payload }) };
    return typeof previewResponse === 'function' ? previewResponse(options) : previewResponse;
  };
  try {
    return { result: await resolveShareTv('test', { shareTvBase: base, shareTvApiKey: key }), calls };
  } finally { global.fetch = original; }
}

test('ShareTV public programme artwork wins while optional preview supplies descriptions', async () => {
  const { result, calls } = await resolve({ ...share, active_program_id: 7,
    programs: [{ id: 7, start_at: 90, end_at: 110, title: 'Public programme', icon_url: '/programme.jpg' }] }, null, 'secret');
  assert.equal(result.thumbnail, `${base}/programme.jpg`);
  assert.equal(calls.length, 2);
  assert.equal(result.streamUrl, `${base}/api/public/stream/test`);
  assert.equal(result.isLive, true);
});

test('ShareTV static event schedule uses starts_at/ends_at and ignores expired active IDs', async () => {
  const { result } = await resolve({ ...share, active_event_id: 1, programs: [
    { id: 1, starts_at: 80, ends_at: 100, icon_url: '/stale.jpg' },
    { id: 2, starts_at: 100, ends_at: 110, icon_url: '/current.jpg' }
  ] });
  assert.equal(result.thumbnail, `${base}/current.jpg`);
});

test('ShareTV channel-only integration metadata uses configured host, key header, and disables redirects', async () => {
  const { result, calls } = await resolve(share, { ok: true, json: async () => ({
    preview: { channel_name: 'Channel', programme: { title: 'Programme', icon_url: '/epg.jpg' } }
  }) }, 'secret');
  assert.equal(result.thumbnail, `${base}/epg.jpg`);
  assert.equal(result.title, 'Programme');
  assert.equal(result.channel, 'Channel');
  assert.equal(calls[1].url, `${base}/api/integrations/discord/share/test/preview`);
  assert.equal(calls[1].options.headers['X-API-Key'], 'secret');
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(calls[0].options.headers['X-API-Key'], undefined);
});

test('ShareTV missing API/key and unsafe artwork preserve existing playback', async () => {
  for (const response of [{ ok: false, status: 404 }, { ok: true, json: async () => ({ preview: {
    programme: { icon_url: 'file:///secret' }
  } }) }, () => { throw new Error('offline'); }]) {
    const { result } = await resolve(share, response, 'secret');
    assert.equal(result.thumbnail, `${base}/channel.jpg`);
    assert.equal(result.available, true);
  }
  const { calls } = await resolve(share, null);
  assert.equal(calls.length, 1);
});

test('ShareTV optional metadata has a hard budget even when its JSON body stalls', async () => {
  const start = Date.now();
  const { result, calls } = await resolve(share, { ok: true, json: () => new Promise(() => {}) }, 'secret');
  assert.ok(Date.now() - start < 2500);
  assert.equal(calls[1].options.signal.aborted, true);
  assert.equal(result.available, true);
  assert.equal(result.thumbnail, `${base}/channel.jpg`);
});

test('ShareTV preserves actual programme independently of share title', async () => {
  const { result } = await resolve({ ...share, title: 'Shared channel' }, { ok: true, json: async () => ({
    preview: { programme: { title: 'Actual programme' } }
  }) }, 'secret');
  assert.equal(result.title, 'Shared channel');
  assert.equal(result.contentTitle, 'Actual programme');
});


test('ShareTV initial descriptions come from preview across channel, programme and static shares', async () => {
  for (const shape of [{ channel_id: 1 }, { mode: 'programs' }, { kind: 'static' }]) {
    for (const description of [' Full stored description. ', null, undefined]) {
      const { result } = await resolve({ ...share, ...shape }, { ok: true, json: async () => ({
        preview: { programme: { title: 'Programme', description } }
      }) }, 'secret');
      assert.equal(result.programmeDescription, description ?? null);
    }
  }
});
