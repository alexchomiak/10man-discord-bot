# Real streambot memory sandbox

This runs the production Docker image, logs into Discord with one dedicated
test account, joins the configured voice channel, and streams a long-form URL
through the real FFmpeg, node-av, WebRTC, and Discord path.

Docker enforces a 2 GiB memory ceiling, a 256-process limit, and a four-CPU
limit. The runner always removes its one named container and never kills
unrelated host processes.

1. Fill `tools/streambot-memory-sandbox/.env`. Use a test account token and a
   combined A/V Jellyfin URL valid for at least 30 minutes.
2. Ensure no other instance is using that test account.
3. From the repository root, run:

   ```sh
   bash tools/streambot-memory-sandbox/run.sh
   ```

Open the Go Live stream from a normal Discord client when the runner tells you
to. The automated test independently requires both FFmpeg output and encoded
payload handed to a ready WebRTC transport to advance; producer output alone
cannot pass. (The native library's generic `bytesSent()` statistic does not
count RTP media.)

The default run is 30 minutes. Results go to
`tools/streambot-memory-sandbox/out/REPORT.md`; five-second samples go to
`memory.tsv`. A pass requires continued sender progress, no OOM kill, and no
more than 256 MiB of growth after the two-minute warm-up. A 60-second WebRTC
delivery stall fails early instead of letting earlier progress hide a wedged
stream. Final acceptance also requires the human viewer to confirm that Discord
rendered moving video and audio; a sender cannot prove remote decoding by
itself.

The laptop sandbox uses software encoding and normal networking. GPU behavior
is outside this test; the faulty mux/backpressure path is exercised in full.
