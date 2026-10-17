'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const sharp = require('sharp');
const { WebSocket } = require('ws');
const { PresenceArtwork, fetchPresenceArtwork } = require('../src/streambot/presenceArtwork');
const { artworkScope, MAX_ARTWORK_BYTES } = require('../src/presenceArtwork');
const { StreamBroker } = require('../src/streamBroker');
const { createStreamDashboard } = require('../src/streamDashboard');
const active = () => ({ alive: true, inChannel: true, guildId: '111111111111111111', channelId: '222222222222222222', startedAt: 10,
  current: { id: 'piece', sourceKind: 'jellyfin', title: 'Movie', thumbnail: 'http://private/Items/x/Images/Primary?api_key=secret' } });
const jpeg = () => sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail('not settled'); }

test('presence artwork fetch bounds bytes, pixels, types, cancellation and reencodes JPEG', async t => {
  const image = await jpeg();
  const server = http.createServer((req, res) => {
    if (req.url === '/slow') return;
    if (req.url === '/redirect') { res.writeHead(302, { location: '/' }); res.end(); return; }
    if (req.url === '/large') { res.writeHead(200, { 'content-type': 'image/jpeg' }); res.end(Buffer.alloc(3 * 1024 * 1024 + 1)); return; }
    if (req.url === '/pixels') { res.writeHead(200, { 'content-type': 'image/png' }); sharp({ create: { width: 4097, height: 4097, channels: 3, background: 'red' } }).png().toBuffer().then(b => res.end(b)); return; }
    res.writeHead(200, { 'content-type': req.url === '/html' ? 'text/html' : 'image/jpeg' }); res.end(image);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const output = await fetchPresenceArtwork(base, new AbortController().signal);
  assert.equal((await sharp(output).metadata()).format, 'jpeg');
  assert.ok(output.length <= MAX_ARTWORK_BYTES);
  const portrait = await sharp({ create: { width: 20, height: 40, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => new Response(portrait, { headers: { 'content-type': 'image/jpeg' } });
    const natural = await fetchPresenceArtwork(base, undefined, { preserveAspect: true });
    const metadata = await sharp(natural).metadata();
    assert.equal(metadata.width, 20); assert.equal(metadata.height, 40);
    assert.equal(metadata.exif, undefined);
  } finally { global.fetch = originalFetch; }
  assert.equal(await fetchPresenceArtwork(base + '/large'), null);
  assert.equal(await fetchPresenceArtwork(base + '/pixels'), null);
  assert.equal(await fetchPresenceArtwork(base + '/html'), null);
  assert.equal(await fetchPresenceArtwork(base + '/redirect', undefined, { preserveAspect: true }), null);
  const abort = new AbortController();
  const pending = fetchPresenceArtwork(base + '/slow', abort.signal); abort.abort();
  assert.equal(await pending, null);
});

test('worker artwork retries transient failures, cancels stale content, and exposes capability only', async () => {
  let status = active(), now = 0, calls = 0, settle;
  const published = [];
  const manager = { config: { dashboardBaseUrl: 'https://player.example/watch', workerId: 'one', playerPresenceApplicationId: '123456789012345678' }, status: () => status };
  const controller = new PresenceArtwork(manager, a => { published.push(a); return true; }, {
    now: () => now, fetchImage: async () => { calls++; return null; }
  });
  controller.sync(); await controller.flight.promise;
  controller.sync(); assert.equal(calls, 1);
  now = 60000; controller.sync(); await controller.flight.promise; assert.equal(calls, 2);
  controller.fetchImage = () => new Promise(r => { settle = r; });
  now += 60000; controller.sync(); const old = controller.flight; await Promise.resolve();
  status = { ...status, current: { ...status.current, contentTitle: 'Next programme' } };
  controller.sync(); assert.equal(old.controller.signal.aborted, true);
  controller.fetchImage = jpeg; settle(await jpeg()); await old.promise;
  await controller.flight.promise;
  assert.equal(published.length, 1);
  assert.equal(published[0].scope, artworkScope(status));
  assert.match(controller.url(), /^https:\/\/player.example\/api\/public\/one\/artwork\/[a-f0-9]{32}\.jpg$/);
  assert.ok(!controller.url().includes('secret'));
  status = null; controller.sync(); assert.equal(controller.url(), null);
  controller.close();
});

test('broker artwork is private, scoped to current content and random public code, and inactive URLs expire', async t => {
  const broker = new StreamBroker({ host: '127.0.0.1', port: 0, secret: 'test', log: () => {} });
  await once(broker.start(), 'listening');
  const socket = new WebSocket(`ws://127.0.0.1:${broker.port}`, { headers: { authorization: 'Bearer test' } });
  await once(socket, 'open');
  let status = active();
  socket.send(JSON.stringify({ type: 'register', workerId: 'one', userId: '333333333333333333', accessCode: 'abcdef', status }));
  await until(() => broker.getWorker('one'));
  const dashboard = createStreamDashboard({ broker, password: 'admin', randomCodes: true, host: '127.0.0.1', port: 0, log: () => {} });
  dashboard.listen(); await once(dashboard.server, 'listening');
  t.after(async () => { socket.terminate(); await dashboard.close(); await broker.close(); });
  const capability = 'a'.repeat(32), bytes = await jpeg();
  const upload = data => socket.send(JSON.stringify({ type: 'presence-artwork', capability, scope: artworkScope(status), jpeg: bytes.toString('base64'), ...data }));
  upload(); await until(() => broker.getPresenceArtwork('one', capability));
  assert.equal(JSON.stringify(broker.getWorker('one')).includes('capability'), false);
  const base = `http://127.0.0.1:${dashboard.server.address().port}/api/public/`;
  const path = `/artwork/${capability}.jpg`;
  const image = await fetch(base + 'abcdef' + path);
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
  assert.equal((await fetch(base + 'one' + path)).status, 404);
  assert.equal((await fetch(base + 'abcdef' + path + '?url=http://private')).status, 404);
  status = { ...status, current: { ...status.current, contentTitle: 'Changed EPG' } };
  socket.send(JSON.stringify({ type: 'status', status }));
  await until(() => !broker.getPresenceArtwork('one', capability));
  assert.equal((await fetch(base + 'abcdef' + path)).status, 404);
  upload({ jpeg: Buffer.alloc(MAX_ARTWORK_BYTES + 1).toString('base64') });
  await new Promise(r => setTimeout(r, 20)); assert.equal(broker.getPresenceArtwork('one', capability), null);
  upload(); await until(() => broker.getPresenceArtwork('one', capability));
  status = { ...status, inChannel: false }; socket.send(JSON.stringify({ type: 'status', status }));
  await until(() => broker.getWorker('one').status.inChannel === false);
  assert.equal((await fetch(base + 'abcdef' + path)).status, 404);
});

test('disabled or disconnected artwork aborts immediately and never starts new fetches', async () => {
  const status = active(); let calls = 0, available = true, settle;
  const manager = { config: {}, status: () => status };
  const artwork = new PresenceArtwork(manager, () => assert.fail('must not publish'), {
    isAvailable: () => available,
    fetchImage: () => { calls++; return new Promise(r => { settle = r; }); }
  });
  artwork.sync(); assert.equal(calls, 0);
  manager.config = { dashboardBaseUrl: 'https://player.example', workerId: 'one', playerPresenceApplicationId: '123456789012345678' };
  artwork.sync(); const pending = artwork.flight; await Promise.resolve(); assert.equal(calls, 1);
  available = false; artwork.sync(); assert.equal(pending.controller.signal.aborted, true);
  settle(await jpeg()); await pending.promise;
  assert.equal(artwork.url(), null); assert.equal(artwork.scope, null);
  artwork.sync(); assert.equal(calls, 1);
  artwork.close();
});

test('worker publishes complete status before artwork and revokes immediately at event end', async () => {
  const { StreamBrokerClient } = require('../src/streambot/brokerClient');
  let status = active(); const sent = [];
  const manager = { config: { dashboardBaseUrl: 'https://player.example', workerId: 'one', playerPresenceApplicationId: '123456789012345678' },
    status: () => status, contentAwareImagePreview: true, deriveNicknameFromContent: true, musicMode: true };
  const worker = new StreamBrokerClient({ streamManager: manager, log: () => {} });
  worker.socket = { readyState: WebSocket.OPEN, send: text => sent.push(JSON.parse(text)), terminate() {} };
  worker.artwork.fetchImage = jpeg;
  worker.artwork.sync(); await worker.artwork.flight.promise;
  assert.equal(sent[0].type, 'status'); assert.equal(sent.at(-1).type, 'presence-artwork');
  for (const message of sent.filter(x => x.type === 'status')) {
    assert.equal(message.contentAwareImagePreview, true);
    assert.equal(message.deriveNicknameFromContent, true);
    assert.equal(message.musicMode, true);
  }
  status = { ...status, current: null }; worker.artwork.sync();
  assert.equal(sent.at(-1).type, 'status'); assert.equal(sent.at(-1).status.current, null);
  assert.equal(worker.artwork.url(), null);
  worker.close(); assert.equal(worker.artwork.closed, true);
});
