'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { once } = require('node:events');
const { StreamBroker } = require('../src/streamBroker');
const { StreamBrokerClient } = require('../src/streambot/brokerClient');
const { streamCommand, playerCommand, setStreamNameCommand, playerComponents } = require('../src/streamInteractions');
const { StreamControl } = require('../src/streambot/control');

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
  const manager = { status: () => ({ title: 'Video', paused: false, queued: 1 }) };
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

test('stream control changes the account global display name, not a guild nickname', async () => {
  const changed = [];
  const manager = { status: () => null };
  const control = new StreamControl({
    streamManager: manager,
    config: {},
    client: { user: { setGlobalName: async name => { changed.push(name); } } }
  });
  const result = await control.execute('setDisplayName', { name: 'Movie Night' });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(changed, ['Movie Night']);
  assert.match(result.message, /Movie Night/);

  const invalid = await control.execute('setDisplayName', { name: 'x'.repeat(33) });
  assert.strictEqual(invalid.ok, false);
  assert.deepStrictEqual(changed, ['Movie Night']);
});
