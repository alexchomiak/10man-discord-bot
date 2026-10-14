'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ContentNickname, contentNickname } = require('../src/streambot/contentNickname');

test('truncation keeps graphemes, limits and reasonable word boundaries', () => {
  assert.equal(contentNickname('  Example\nprogramme  '), 'Example programme');
  assert.equal(contentNickname('A'.repeat(40)), 'A'.repeat(29) + '...');
  assert.equal(contentNickname('An interesting programme with more words'), 'An interesting programme...');
  for (const value of ['語'.repeat(40), '😀'.repeat(40), '👩‍👩‍👧‍👦'.repeat(10)]) {
    const name = contentNickname(value);
    assert.ok(name.length <= 32);
    assert.ok(name.endsWith('...'));
    assert.ok(!/[\uD800-\uDBFF]$/.test(name.slice(0, -3)));
    assert.ok(!name.slice(0, -3).endsWith('\u200d'));
  }
});

test('default off, self guild only, programme priority, dedup and explicit off', async () => {
  const calls = [];
  const member = { nickname: null, setNickname: async name => { calls.push(name); member.nickname = name; } };
  const client = { user: { id: 'self' }, guilds: { cache: new Map([['guild', { members: { me: member } }]]) } };
  const automation = new ContentNickname(client);
  const piece = { guildId: 'guild', sourceKind: 'sharetv', title: 'Channel', contentTitle: 'Actual programme' };
  automation.update(piece);
  await automation.pending;
  assert.deepEqual(calls, []);
  automation.setEnabled(true);
  automation.update(piece);
  automation.update(piece);
  await automation.pending;
  assert.deepEqual(calls, ['Actual programme']);
  automation.update({ ...piece, isFiller: true });
  automation.update({ ...piece, sourceKind: 'direct' });
  automation.setEnabled(false);
  automation.update({ ...piece, contentTitle: 'Next' });
  await automation.pending;
  assert.deepEqual(calls, ['Actual programme']);
});

test('permission failures are swallowed and deduplicated', async () => {
  let calls = 0, errors = 0;
  const automation = new ContentNickname({ user: { id: 'self' }, guilds: { cache: new Map([['g', { members: { me: {
    setNickname: async () => { calls++; throw new Error('Missing permissions'); }
  } } }]]) } }, () => errors++);
  automation.setEnabled(true);
  const piece = { guildId: 'g', sourceKind: 'youtube', title: 'Video' };
  automation.update(piece);
  await automation.pending;
  automation.update(piece);
  await automation.pending;
  assert.equal(calls, 1);
  assert.equal(errors, 1);
});

test('disabling cancels queued updates before REST', async () => {
  let calls = 0;
  const automation = new ContentNickname({ guilds: { cache: new Map([['g', { members: { me: { setNickname: async () => calls++ } } }]]) } });
  automation.setEnabled(true);
  automation.update({ guildId: 'g', sourceKind: 'jellyfin', title: 'Film' });
  automation.setEnabled(false);
  await automation.pending;
  assert.equal(calls, 0);
});

test('aborted playback during member lookup suppresses stale update', async () => {
  let release, calls = 0;
  const control = new AbortController();
  const memberPromise = new Promise(resolve => { release = resolve; });
  const automation = new ContentNickname({ user: { id: 'self' }, guilds: { cache: new Map([['g', { members: { fetch: () => memberPromise } }]]) } });
  automation.setEnabled(true);
  automation.update({ guildId: 'g', sourceKind: 'youtube', title: 'Video', control });
  await Promise.resolve();
  control.abort();
  release({ setNickname: async () => calls++ });
  await automation.pending;
  assert.equal(calls, 0);
});

test('channel nickname never falls back to generic share or channel title without EPG', async () => {
  let calls = 0;
  const automation = new ContentNickname({ guilds: { cache: new Map([['g', { members: { me: { setNickname: async () => calls++ } } }]]) } });
  automation.setEnabled(true);
  automation.update({ guildId: 'g', sourceKind: 'sharetv', shareTvChannel: true, title: 'Channel name', contentTitle: null });
  await automation.pending;
  assert.equal(calls, 0);
});

test('ShareTV preview polling stays active with content nickname off and deduplicates signed images', async () => {
  const { StreamManager } = require('../src/streambot/streamManager');
  const manager = new StreamManager({}, null, { shareTvBase: 'https://tv.example', shareTvApiKey: 'test-key' });
  const link = { paused: false, closing: false };
  const piece = { voiceLink: link, previewPipeline: {}, control: new AbortController() };
  manager.session = piece;
  manager.voiceLink = link;
  let synced, uploads = 0;
  manager.shareTvNicknameRefresh.sync = current => { synced = current; };
  manager._updateStillPreview = async current => { uploads++; current.previewImageFailed = false; return true; };
  manager.setContentNickname(false);
  assert.equal(synced, piece);
  assert.equal(manager.shareTvNicknameRefresh.isCurrent(piece), true);
  const programme = { id: 1, title: 'Current programme', end_at: 9000, icon_url: '/image/1?sig=one' };
  await manager.shareTvNicknameRefresh.onProgramme(piece, programme.title, programme);
  await manager.shareTvNicknameRefresh.onProgramme(piece, programme.title, { ...programme, icon_url: '/image/1?sig=two' });
  assert.equal(uploads, 1);
  assert.equal(piece.contentTitle, programme.title);
  assert.equal(piece.thumbnail, 'https://tv.example/image/1?sig=two');
  piece.previewImageFailed = true;
  await manager.shareTvNicknameRefresh.onProgramme(piece, programme.title, programme);
  assert.equal(uploads, 2);
  await manager.shareTvNicknameRefresh.onProgramme(piece, 'Next', { ...programme, id: 2, icon_url: '/image/2' });
  assert.equal(uploads, 3);
  manager.voiceLink = {};
  assert.equal(manager.shareTvNicknameRefresh.isCurrent(piece), false);
});
