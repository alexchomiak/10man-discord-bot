'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function until(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('supervisor did not reach the expected state');
}

test('a crashed child restarts without stopping its healthy sibling; shutdown stops restarts', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-supervisor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = path.join(dir, 'events');
  const marker = path.join(dir, 'crashed-once');
  const childScript = path.join(dir, 'child.js');
  const supervisorScript = path.join(dir, 'supervisor.js');
  fs.writeFileSync(childScript, `
    const fs = require('node:fs');
    fs.appendFileSync(process.env.EVENTS, process.env.NAME + ':' + process.pid + '\\n');
    if (process.env.NAME === 'crashy' && !fs.existsSync(process.env.MARKER)) {
      fs.writeFileSync(process.env.MARKER, 'yes');
      process.exit(7);
    }
    process.on('message', message => {
      if (message === 'supervisor:ping') process.send('supervisor:pong');
    });
    setInterval(() => {}, 1000);
  `);
  fs.writeFileSync(supervisorScript, `
    const { superviseChildren } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'superviseChildren.js'))});
    superviseChildren(['healthy', 'crashy'].map(name => ({
      name, script: ${JSON.stringify(childScript)}, env: { NAME: name, EVENTS: ${JSON.stringify(events)}, MARKER: ${JSON.stringify(marker)} }
    })), { baseDelayMs: 50, maxDelayMs: 100 });
  `);
  const supervisor = spawn(process.execPath, [supervisorScript], { stdio: 'ignore' });
  t.after(() => { if (supervisor.exitCode === null) supervisor.kill('SIGKILL'); });
  const entries = () => fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split('\n') : [];
  await until(() => entries().filter(line => line.startsWith('crashy:')).length >= 2);
  assert.equal(entries().filter(line => line.startsWith('healthy:')).length, 1);
  supervisor.kill('SIGTERM');
  await new Promise(resolve => supervisor.once('exit', resolve));
  const count = entries().length;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(entries().length, count, 'intentional shutdown must not restart children');
});

test('an unresponsive child is replaced by the heartbeat watchdog', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-watchdog-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const events = path.join(dir, 'events');
  const childScript = path.join(dir, 'child.js');
  const supervisorScript = path.join(dir, 'supervisor.js');
  fs.writeFileSync(childScript, `
    require('node:fs').appendFileSync(${JSON.stringify(events)}, process.pid + '\\n');
    setInterval(() => {}, 1000);
  `);
  fs.writeFileSync(supervisorScript, `
    require(${JSON.stringify(path.join(__dirname, '..', 'src', 'superviseChildren.js'))})
      .superviseChildren([{ name: 'hung', script: ${JSON.stringify(childScript)} }],
        { heartbeatIntervalMs: 20, heartbeatTimeoutMs: 100, baseDelayMs: 20 });
  `);
  const supervisor = spawn(process.execPath, [supervisorScript], { stdio: 'ignore' });
  t.after(() => { if (supervisor.exitCode === null) supervisor.kill('SIGKILL'); });
  const launches = () => fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split('\n').length : 0;
  await until(() => launches() >= 2);
  supervisor.kill('SIGTERM');
  await new Promise(resolve => supervisor.once('exit', resolve));
});
