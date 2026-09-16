'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { StreamBroker } = require('../src/streamBroker');
const { StreamBrokerClient } = require('../src/streambot/brokerClient');
const { StreamControl } = require('../src/streambot/control');
const { streamCommand, playerCommand, setStreamNameCommand, playerComponents, setStreambotNickname } = require('../src/streamInteractions');

async function until(check) {
  for (let i = 0; i < 100; i += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('condition did not settle');
}

test('broker: default and explicit worker routing, command correlation and status updates', async t => {
  const broker = new StreamBroker({ host: '127.0.0.1', port: 0, secret: 'test-secret', defaultWorkerId: 'primary', log: () => {} });
  const server = broker.start();
  await once(server, 'listening');
  const calls = [];
  const manager = { client: { user: { id: '111111111111111111' } }, status: () => ({ title: 'Video', paused: false, queued: 1 }) };
  const control = { execute: async (operation, payload) => {
    calls.push({ operation, payload });
    return { ok: true, message: `${operation} ok`, status: manager.status() };
  } };
  const worker = new StreamBrokerClient({
    url: `ws://127.0.0.1:${broker.port}`,
    secret: 'test-secret', workerId: 'primary', control, streamManager: manager, log: () => {}
  });
  const secondaryCalls = [];
  const secondary = new StreamBrokerClient({
    url: `ws://127.0.0.1:${broker.port}`,
    secret: 'test-secret', workerId: 'youtube',
    control: { execute: async (operation, payload) => {
      secondaryCalls.push({ operation, payload });
      return { ok: true, message: `youtube ${operation} ok`, status: manager.status() };
    } },
    streamManager: manager, log: () => {}
  });
  t.after(async () => { worker.close(); secondary.close(); await broker.close(); });
  worker.start();
  secondary.start();
  await until(() => broker.listWorkers().length === 2);

  const result = await broker.request('scrub', { deltaSec: 30 });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.message, 'scrub ok');
  assert.deepStrictEqual(calls, [{ operation: 'scrub', payload: { deltaSec: 30 } }]);
  const secondaryResult = await broker.request('pause', {}, 'youtube');
  assert.strictEqual(secondaryResult.message, 'youtube pause ok');
  assert.deepStrictEqual(secondaryCalls, [{ operation: 'pause', payload: {} }]);
  assert.strictEqual(broker.resolveWorkerId(null), 'primary');
  assert.deepStrictEqual(broker.listWorkers().map(item => item.id).sort(), ['primary', 'youtube']);
  assert.strictEqual(broker.getWorker('primary').userId, '111111111111111111');
  assert(!broker.getWorker('primary').capabilities.includes('setDisplayName'));
});

test('Discord stream commands expose every operation and player scrub buttons', () => {
  const stream = streamCommand.toJSON();
  assert.deepStrictEqual(stream.options.map(option => option.name), [
    'ping', 'play', 'join', 'stop', 'status', 'skip', 'scrub', 'pause', 'resume', 'catchup'
  ]);
  assert.strictEqual(playerCommand.toJSON().name, 'player');
  const setName = setStreamNameCommand.toJSON();
  assert.strictEqual(setName.name, 'set-stream-name');
  assert.deepStrictEqual(setName.options.map(option => option.name), ['name', 'bot']);
  const rows = playerComponents('primary').map(row => row.toJSON());
  const labels = rows.flatMap(row => row.components.map(component => component.label));
  assert.deepStrictEqual(labels, ['Pause', 'Resume', '−1m', '−30s', '−5s', '+5s', '+30s', '+1m']);
  assert(rows.flatMap(row => row.components).every(component => component.custom_id.includes('primary')));
});

test('broker offline errors identify connected worker IDs', async t => {
  const broker = new StreamBroker({ host: '127.0.0.1', port: 0, secret: 'test-secret', defaultWorkerId: 'one', log: () => {} });
  const server = broker.start();
  await once(server, 'listening');
  const manager = { client: { user: { id: '222222222222222222' } }, status: () => null };
  const primary = new StreamBrokerClient({
    url: `ws://127.0.0.1:${broker.port}`,
    secret: 'test-secret', workerId: 'primary',
    control: { execute: async () => ({ ok: true }) }, streamManager: manager, log: () => {}
  });
  t.after(async () => { primary.close(); await broker.close(); });
  primary.start();
  await until(() => broker.listWorkers().length === 1);
  await assert.rejects(() => broker.request('status'), /Streambot 'one' is offline\. Connected workers: primary\./);
});

test('control: join results are JSON-safe when manager returns live timer objects', async () => {
  const circular = {};
  circular.timer = circular;
  const manager = {
    status: () => ({ alive: true }),
    ensureChannel: async () => ({ ok: true, reused: true, fillerStarted: false, voiceLink: circular }),
    start: async () => ({ ok: true, queued: false, chained: true, bufferInserted: false, session: circular, pipeline: circular })
  };
  const control = new StreamControl({ streamManager: manager, config: { guildId: 'g', streamChannelId: 'c' } });
  const joined = await control.execute('join');
  assert.doesNotThrow(() => JSON.stringify(joined));
  assert.deepStrictEqual(joined.detail, { reused: true, fillerStarted: false });
});

test('broker client: a circular command result gets a serializable failure response', async () => {
  const sent = [];
  const logs = [];
  const circular = {};
  circular.self = circular;
  const manager = { status: () => null };
  const client = new StreamBrokerClient({
    workerId: 'one', streamManager: manager,
    control: { execute: async () => ({ ok: true, detail: circular }) },
    log: line => logs.push(line)
  });
  client.socket = { readyState: WebSocket.OPEN, send: payload => sent.push(JSON.parse(payload)) };
  await client._message(Buffer.from(JSON.stringify({ type: 'command', requestId: 'r1', operation: 'join', payload: {} })));
  assert.strictEqual(sent[0].type, 'result');
  assert.strictEqual(sent[0].requestId, 'r1');
  assert.strictEqual(sent[0].result.ok, false);
  assert.match(logs[0], /serialization failed/);
  assert.strictEqual(client.results.has('r1'), false);
});

test('/set-stream-name changes the connected worker nickname through the CS app bot', async () => {
  const changes = [];
  const interaction = {
    user: { id: '333333333333333333' },
    guild: {
      name: 'Movie Club',
      members: {
        fetch: async id => ({
          manageable: true,
          setNickname: async (name, reason) => changes.push({ id, name, reason })
        })
      }
    }
  };
  const broker = { getWorker: id => id === 'one' ? { id, userId: '444444444444444444' } : null };
  const message = await setStreambotNickname(interaction, broker, 'one', 'Movie Night');
  assert.match(message, /Movie Night.*Movie Club/);
  assert.deepStrictEqual(changes, [{
    id: '444444444444444444',
    name: 'Movie Night',
    reason: 'Stream name set by 333333333333333333'
  }]);
  await assert.rejects(
    () => setStreambotNickname(interaction, broker, 'offline', 'Movie Night'),
    /offline or has not registered/
  );
});
