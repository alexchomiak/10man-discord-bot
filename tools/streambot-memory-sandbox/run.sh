#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ENV_FILE="${1:-$HERE/.env}"
OUT="$HERE/out"
CONTAINER="10man-memory-sandbox"
IMAGE="10man-memory-sandbox:latest"
HOST_PORT="${SANDBOX_HOST_PORT:-18081}"
LIMIT=$((2 * 1024 * 1024 * 1024))
mkdir -p "$OUT"
METRICS="$OUT/memory.tsv"
BOT_LOG="$OUT/bot.log"
REPORT="$OUT/REPORT.md"
rm -f "$METRICS" "$BOT_LOG" "$REPORT"

command -v docker >/dev/null || { echo 'Docker is required.' >&2; exit 2; }
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE" >&2; exit 2; }

read_env() {
  node - "$ENV_FILE" "$1" <<'NODE'
require('dotenv').config({ path: process.argv[2] });
process.stdout.write(String(process.env[process.argv[3]] || ''));
NODE
}

for key in SELF_BOT_TOKEN SBOT_GUILD_ID STREAM_CHANNEL_ID SANDBOX_MEDIA_URL WEBHOOK_SECRET; do
  [ -n "$(read_env "$key")" ] || { echo "Fill $key in $ENV_FILE" >&2; exit 2; }
done
DURATION="$(read_env SANDBOX_DURATION_SECONDS)"; DURATION="${DURATION:-1800}"
[[ "$DURATION" =~ ^[0-9]+$ ]] && [ "$DURATION" -ge 300 ] || {
  echo 'SANDBOX_DURATION_SECONDS must be an integer of at least 300.' >&2; exit 2;
}

cleanup_done=0
cleanup() {
  [ "$cleanup_done" -eq 0 ] || return
  cleanup_done=1
  if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    docker logs "$CONTAINER" > "$BOT_LOG" 2>&1 || true
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

echo '[sandbox] building the exact application image'
docker build -t "$IMAGE" "$ROOT"
printf 'elapsed_s\tmemory_bytes\tmemory_limit_bytes\tffmpeg_bytes_total\trtc_bytes_total\n' > "$METRICS"

echo '[sandbox] starting one worker with a kernel-enforced 2 GiB memory ceiling'
docker run -d --name "$CONTAINER" \
  --memory 2g --memory-swap 2g --pids-limit 256 --cpus 4 \
  --tmpfs /tmp:rw,exec,size=512m,mode=1777 \
  --env-file "$ENV_FILE" \
  -e MODE=streambot -e STREAMBOT_IDS=memorytest -e STREAMBOT_DEFAULT_ID=memorytest \
  -e SBOT_CHAT_COMMANDS=false \
  -e STREAMBOT_WEBHOOK_HOST=0.0.0.0 -e STREAMBOT_WEBHOOK_PORT=8081 \
  -e STREAMBOT_VIDEO_ENCODER=software -e STREAMBOT_HARDWARE_DECODE=false \
  -e STREAM_WIDTH=1920 -e STREAM_HEIGHT=1080 -e STREAM_FRAME_RATE=30 \
  -e VERBOSE=true \
  -p "127.0.0.1:${HOST_PORT}:8081" "$IMAGE" >/dev/null

ready=0
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${HOST_PORT}/health" >/dev/null 2>&1; then ready=1; break; fi
  [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)" = true ] || break
  sleep 1
done
[ "$ready" -eq 1 ] || { echo '[sandbox] bot failed to become ready; see out/bot.log' >&2; exit 1; }

SANDBOX_HOST_PORT="$HOST_PORT" node "$HERE/trigger.cjs" "$ENV_FILE"

echo '[sandbox] OPEN THE GO LIVE STREAM IN A NORMAL DISCORD CLIENT and verify that video and audio render.'
start="$(date +%s)"; samples=0; producer_advancing=0; rtc_advancing=0
previous_out=0; previous_rtc=0; peak=0
last_out_advance=0; last_rtc_advance=0; stall_limit=60
first_steady=''; last_memory=0; result=PASS; reason='completed the observation window'
while true; do
  now="$(date +%s)"; elapsed=$((now - start))
  state="$(docker inspect -f '{{.State.Status}} {{.State.OOMKilled}}' "$CONTAINER" 2>/dev/null || echo 'missing false')"
  if [ "$state" != 'running false' ]; then result=FAIL; reason="container stopped early: $state"; break; fi
  memory="$(docker exec "$CONTAINER" sh -c 'cat /sys/fs/cgroup/memory.current 2>/dev/null || echo 0' | tr -dc '0-9')"
  memory="${memory:-0}"
  logs="$(docker logs --tail 30 "$CONTAINER" 2>&1 || true)"
  out="$(printf '%s\n' "$logs" | sed -n 's/.*outBytes_total=\([0-9][0-9]*\).*/\1/p' | tail -1)"
  out="${out:-$previous_out}"
  rtc="$(printf '%s\n' "$logs" | sed -n 's/.*rtcBytes_total=\([0-9][0-9]*\).*/\1/p' | tail -1)"
  rtc="${rtc:-$previous_rtc}"
  [ "$memory" -gt "$peak" ] && peak="$memory"
  if [ "$out" -gt "$previous_out" ]; then
    producer_advancing=$((producer_advancing + 1)); last_out_advance="$elapsed"
  fi
  if [ "$rtc" -gt "$previous_rtc" ]; then
    rtc_advancing=$((rtc_advancing + 1)); last_rtc_advance="$elapsed"
  fi
  previous_out="$out"; previous_rtc="$rtc"; last_memory="$memory"; samples=$((samples + 1))
  [ "$elapsed" -ge 120 ] && [ -z "$first_steady" ] && first_steady="$memory"
  printf '%s\t%s\t%s\t%s\t%s\n' "$elapsed" "$memory" "$LIMIT" "$out" "$rtc" >> "$METRICS"
  printf '[sandbox] %4ss memory=%4s MiB ffmpeg=%s MiB rtc=%s MiB\n' \
    "$elapsed" "$((memory/1024/1024))" "$((out/1024/1024))" "$((rtc/1024/1024))"
  if [ "$elapsed" -ge 120 ] && [ $((elapsed - last_rtc_advance)) -ge "$stall_limit" ]; then
    result=FAIL; reason="ready WebRTC transport made no progress for ${stall_limit}s"; break
  fi
  [ "$elapsed" -ge "$DURATION" ] && break
  sleep 5
done

docker logs "$CONTAINER" > "$BOT_LOG" 2>&1 || true
oom="$(docker inspect -f '{{.State.OOMKilled}}' "$CONTAINER" 2>/dev/null || echo true)"
[ "$oom" = false ] || { result=FAIL; reason='kernel memory limit was reached'; }
[ "$previous_out" -ge 50000000 ] || { result=FAIL; reason='FFmpeg produced fewer than 50 MB'; }
[ "$previous_rtc" -ge 50000000 ] || { result=FAIL; reason='fewer than 50 MB reached a ready WebRTC transport'; }
minimum_advancing=$((DURATION / 20))
[ "$minimum_advancing" -lt 10 ] && minimum_advancing=10
[ "$minimum_advancing" -gt 30 ] && minimum_advancing=30
[ "$producer_advancing" -ge "$minimum_advancing" ] || { result=FAIL; reason="FFmpeg did not advance in at least $minimum_advancing samples"; }
[ "$rtc_advancing" -ge "$minimum_advancing" ] || { result=FAIL; reason="ready WebRTC transport did not advance in at least $minimum_advancing samples"; }
[ $((elapsed - last_out_advance)) -lt "$stall_limit" ] || { result=FAIL; reason="FFmpeg made no progress for ${stall_limit}s"; }
[ $((elapsed - last_rtc_advance)) -lt "$stall_limit" ] || { result=FAIL; reason="ready WebRTC transport made no progress for ${stall_limit}s"; }
growth=0; [ -n "$first_steady" ] && growth=$((last_memory - first_steady))
[ "$growth" -le $((256*1024*1024)) ] || { result=FAIL; reason='steady-state memory grew by more than 256 MiB'; }

cat > "$REPORT" <<EOF
# Streambot memory sandbox: $result

- Result: $reason
- Runtime: ${elapsed}s
- Peak container memory: $((peak/1024/1024)) MiB (hard limit: 2048 MiB)
- Steady-state memory growth: $((growth/1024/1024)) MiB
- Bytes produced by FFmpeg: $previous_out
- Encoded bytes handed to ready WebRTC transport: $previous_rtc
- FFmpeg advancing samples: $producer_advancing / $samples
- WebRTC advancing samples: $rtc_advancing / $samples
- OOM killed: $oom
- Visual playback confirmation: REQUIRED FROM THE HUMAN VIEWER

Detailed samples: memory.tsv
Application output: bot.log
EOF
cat "$REPORT"
[ "$result" = PASS ]
