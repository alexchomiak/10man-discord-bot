'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TimedTrack } = require('../src/streambot/persistentTrackFeeder');

async function runPair(shared, stalledType = 'video') {
  let now = 0;
  const jobs = [];
  const sleep = ms => new Promise(resolve => jobs.push({ at: now + ms, resolve }));
  const timeline = shared ? {} : undefined;
  const sent = { video: [], audio: [] };
  let completed = false;
  const tracks = ['video', 'audio'].map(type => new TimedTrack((_data, duration) => {
    sent[type].push({ at: now, pts: tracks[type === 'video' ? 0 : 1].pts, duration });
  }, type, { now: () => now, sleep, timeline }));
  const run = async (track, type, count, duration) => {
    for (let i = 0; i < count; i++) {
      // An input/encoder stall affects the picture while audio keeps flowing.
      if (type === stalledType && i === 60) await sleep(900);
      const pts = type === 'video' ? 400 + i * 2048 : i * 960;
      const den = type === 'video' ? 61440 : 48000;
      await new Promise((resolve, reject) => track.write({ data: Buffer.from([1]),
        pts: BigInt(pts), duration: BigInt(duration), timeBase: { num: 1, den }, free() {} },
      error => error ? reject(error) : resolve()));
    }
  };
  const running = Promise.all([run(tracks[0], 'video', 180, 2048), run(tracks[1], 'audio', 300, 960)])
    .finally(() => { completed = true; });
  for (let iterations = 0; !completed; iterations++) {
    assert.ok(iterations < 2000, 'both tracks finish without cross-track waits');
    await new Promise(resolve => setImmediate(resolve));
    jobs.sort((a, b) => a.at - b.at);
    const job = jobs.shift();
    if (job) { now = job.at; job.resolve(); }
  }
  await running;
  tracks.forEach(track => track.destroy());
  return sent;
}

const offset = packet => packet.at - packet.pts;
test('VOD shared clock recovers both tracks after an asymmetric video stall', async () => {
  const independent = await runPair(false);
  const shared = await runPair(true);
  assert.ok(offset(independent.video.at(-1)) - offset(independent.audio.at(-1)) > 800,
    'independent clock rebasing reproduces permanent desynchronization');
  assert.ok(Math.abs(offset(shared.video.at(-1)) - offset(shared.audio.at(-1))) < 34,
    'both tracks converge on one media/wall clock');
  assert.equal(shared.video.length, 180);
  assert.equal(shared.audio.length, 300);
  assert.ok(shared.video.slice(62).every((packet, index, tail) => !index ||
    Math.abs(packet.at - tail[index - 1].at - 1000 / 30) < 0.01), 'video resumes steady pacing');
  assert.ok(shared.audio.every(packet => packet.duration === 20), 'Opus RTP duration is preserved');
});

test('VOD shared clock also recovers after an asymmetric audio stall', async () => {
  const sent = await runPair(true, 'audio');
  assert.ok(Math.abs(offset(sent.video.at(-1)) - offset(sent.audio.at(-1))) < 34);
  assert.equal(sent.video.length, 180);
  assert.equal(sent.audio.length, 300);
});
