# sendleak-sandbox

Repro harness for the **unbounded native-memory growth** suspected behind the
Discord streaming-bot OOM on Unraid. All code lives here; nothing outside
`tools/sendleak-sandbox/` is touched. Both scenarios drive the *installed*
`@lng2004/node-datachannel` (libdatachannel 0.24.0) + H264 packetizer stack
- no faked `sendMessageBinary`.

## Files
- `common.js` - SDP loopback, H264 packetizer chain, TSV sampler.
- `scenario_a_sendqueue.js` - backpressure: push `SBOT_FRAME_BYTES`
  frames/s through the real packetizer while the native send/retransmit
  queue is allowed to grow.
- `scenario_b_reconnect.js` - F-3 orphan: repeatedly create a peer and
  overwrite the reference without `close()`; `SBOT_CALL_CLOSE=true` runs the
  control arm.
- `safety.sh` - wallclock + RSS caps, then prints TSV tail + VERDICT.
- `out/*.tsv` - run data.

## Run
```bash
# A (15s smoke):
SBOT_DURATION_MS=15000 bash tools/sendleak-sandbox/safety.sh scenario_a_sendqueue.js

# B orphan (5 iters):
SBOT_CONN_ITERS=5 bash tools/sendleak-sandbox/safety.sh scenario_b_reconnect.js

# B control (5 iters):
SBOT_CONN_ITERS=5 SBOT_CALL_CLOSE=true bash tools/sendleak-sandbox/safety.sh scenario_b_reconnect.js
```
macOS enforces caps with an `ps -o rss` watchdog (bash `ulimit -v` is rejected
on this host); Linux uses `ulimit -v` + `timeout` + `nice`.

## Env knobs
`SBOT_DURATION_MS`(60000) `SBOT_FRAME_BYTES`(204800) `SBOT_FPS`(30)
`SBOT_CONN_ITERS`(20) `SBOT_BURST_FRAMES`(500) `SBOT_CALL_CLOSE`(off)
`SBOT_TSV` `SBT_RUN_SECONDS`(240) `SBT_RSS_LIMIT_KB`(8388608)

## Expected signal
TSV columns: `t_s rss_bytes heap_used external array_buffers native_bytes
frames_sent conns_active vmstat_free_bytes vmstat_wired_bytes`.
The key metric is **`native_bytes = rss - heap_used`**: if it climbs while
`heap_used` is flat, growth is in libdatachannel native memory, not the V8 heap.

VERDICT (last line):
- `UNBOUNDED_GROWTH` - rss grew > 1 GiB
- `BOUNDED` - rss grew < 512 MiB (512M-1G printed as `BOUNDED (grey zone...)`)
- `KILLED_BY_ULIMIT` - watchdog/timeout SIGKILLed node (137/143)

## What this does NOT do
- No real Discord WebSocket or voice UDP socket; no `Streamer`, `VoiceConnection`,
  or `discord.js-selfbot-v13`; everything is loopback between two in-process
  `PeerConnection`s.
- No disk I/O for media, no `ffmpeg`, no video decode - the "frame" is a
  synthesized AnnexB buffer of `SBOT_FRAME_BYTES` fill bytes.
- No VPN, no Discord credentials, no token read from `streambot.env`, no
  `daveSession.encrypt*`.
- No `npm install`; no new dependencies; no edits to `src/`, `test/`,
  `package.json`, or `node_modules/`.
