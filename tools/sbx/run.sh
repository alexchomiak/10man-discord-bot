#!/usr/bin/env bash
# sbx/run.sh -- controlled real-bot sandbox.
#
# Contract (what the user asked for):
#  - Start the ACTUAL bot once (worker `one`), one clean start. NO auto-retry.
#  - Trigger ONCE.
#  - Per-process memory caps (node <= NODE_CAP_MIB, ffmpeg <= FF_CAP_MIB), each
#    on its OWN -- so if one is fine we don't kill the other, and the laptop is
#    never at risk from a sum.
#  - Judge PASS by whether FRAMES DELIVER (outBytes_total keeps rising), not by
#    wall-clock or by capping the send buffer.
#  - Hard wall-clock bound (default 30 min) so this can never run forever.
#
# Env (required):
#   SELF_BOT_TOKEN_ONE, MEDIA_URL, GUILD_ID, CHANNEL_ID
# Env (optional):
#   NODE_CAP_MIB, FF_CAP_MIB, RUN_SEC, SBOT_MAX_BITRATE_KBPS
#
# Never persist the token / URL.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
export PATH="/Users/alexchomiak/.local/bin:/opt/homebrew/bin:$PATH"
OUT="$HERE/out"
mkdir -p "$OUT"
WLOG="$OUT/watchdog.log"
BOT_LOG="$OUT/bot.log"
TEL_TSV="$OUT/tel.tsv"
STATE="$OUT/state.json"
PIDS="$OUT/pids"
TRIGGER="$OUT/trigger.js"
VERDICT="$OUT/VERDICT.md"
: > "$WLOG"; : > "$TEL_TSV"
cp -f "$HERE/watchdog.sh" "$OUT/watchdog.sh"
chmod +x "$OUT/watchdog.sh"

# ---- pre-flight: port must be free, no stale processes -----------------------
PORT="${STREAMBOT_WEBHOOK_PORT:-8091}"
PORT_PID="$(lsof -nP -tiTCP:("$PORT") -sTCP:LISTEN 2>/dev/null | head -1 || true)"
PORT_PID="${PORT_PID:-$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1)}"
if [ -n "$PORT_PID" ]; then
  pkill -9 -f 'streambot/supervisor' 2>/dev/null || true
  pkill -9 -f 'streambot/index' 2>/dev/null || true
  pkill -9 -f ffmpeg 2>/dev/null || true
  kill -9 "$PORT_PID" 2>/dev/null || true
  sleep 2
fi
pkill -9 -f 'streambot/supervisor' 2>/dev/null || true
pkill -9 -f 'streambot/index' 2>/dev/null || true
pkill -9 -f ffmpeg 2>/dev/null || true
sleep 1

# ---- find a usable node (>= 22.4 for global WebSocket) ----------------------
node_has_websocket() { local n="$1"; [ -x "$n" ] || return 1; "$n" -e 'process.exit(typeof WebSocket==="function"?0:1)' 2>/dev/null; }
NODE_BIN=""
for cand in "$HOME"/.nvm/versions/node/v22.*/bin/node /opt/homebrew/opt/node@22/bin/node /opt/homebrew/bin/node /usr/local/bin/node; do
  if node_has_websocket "$cand"; then NODE_BIN="$cand"; break; fi
done
[ -z "$NODE_BIN" ] && { echo "FATAL: no Node >= 22.4" >&2; exit 3; }
NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd)/$(basename "$NODE_BIN")"
export PATH="$(dirname "$NODE_BIN"):$PATH"

: "${SELF_BOT_TOKEN_ONE:?SELF_BOT_TOKEN_ONE env required}"
: "${MEDIA_URL:?MEDIA_URL env required}"
GUILD_ID="${GUILD_ID:-145381671552679936}"
CHANNEL_ID="${CHANNEL_ID:-1485806189416808459}"
NODE_CAP_MIB="${NODE_CAP_MIB:-4096}"
FF_CAP_MIB="${FF_CAP_MIB:-8192}"
RUN_SEC="${RUN_SEC:-1800}"
WEBHOOK_SECRET="sbx_$$_$(date +%s | tr 0-9 a-f)"
PORT="${PORT:-8091}"

# ---- redaction -----------------------------------------------------------------
sanitize() {
  local SECRET_PREFIX="${SELF_BOT_TOKEN_ONE:0:24}"
  local f
  for f in "$BOT_LOG" "$WLOG" "$TEL_TSV" "$STATE" "$VERDICT" "$PIDS" ; do
    [ -f "$f" ] || continue
    sed -i '' -E \
      -e 's|ApiKey=[^&"[:space:]]+|ApiKey=<REDACTED>|g' \
      -e 's|jelly\.chom\.es|<REDACTED_HOST>|g' \
      -e "s|${SECRET_PREFIX}[[.A-Za-z0-9_/-]*|<REDACTED_TOKEN>|g" \
      "$f" 2>/dev/null || true
  done
  if [ -d "$OUT/crash" ]; then
    for f in "$OUT/crash"/*; do
      [ -f "$f" ] || continue
      sed -i '' -E \
        -e 's|ApiKey=[^&"[:space:]]+|ApiKey=<REDACTED>|g' \
        -e 's|jelly\.chom\.es|<REDACTED_HOST>|g' \
        -e "s|${SECRET_PREFIX}[[.A-Za-z0-9_/-]*|<REDACTED_TOKEN>|g" \
        "$f" 2>/dev/null || true
    done
  fi
}
sanitize  # run once now (before bot even starts), once at the end too.

# ============================================================================
# SANDBOX TRIGGER (self-contained -- same protocol as webhookServer.js)
# Reads (env): MEDIA_URL / SECRET / GUILD_ID / CHANNEL_ID / PORT
# Exits 0 on {ok:true}, else 1.
# ============================================================================
cat > "$TRIGGER" <<'TRIGGER_EOF'
'use strict';
const http = require('http');
const crypto = require('crypto');
const MEDIA_URL = process.env.MEDIA_URL;
const SECRET = process.env.SBX_TRIGGER_SECRET;
const GUILD_ID = process.env.GUILD_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;
const PORT = process.env.SBX_TRIGGER_PORT || '8091';
function die(msg, code){process.stderr.write('TRIGGER '+msg+'\n');process.exit(code==null?1:code);}
if (!MEDIA_URL) die('MEDIA_URL env required', 2);
if (!SECRET) die('SBX_TRIGGER_SECRET env required', 2);
if (!GUILD_ID) die('GUILD_ID env required', 2);
if (!CHANNEL_ID) die('CHANNEL_ID env required', 2);
function sanitize(s){
  s = String(s || '');
  s = s.replace(/ApiKey=[^&\s"]+/gi, 'ApiKey=<REDACTED>');
  s = s.replace(/jelly\.chom\.es/gi, '<REDACTED_HOST>');
  return s;
}
const body = JSON.stringify({ stream_url: MEDIA_URL, guild_id: GUILD_ID, channel_id: CHANNEL_ID });
const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
const req = http.request({
  host: '127.0.0.1', port: Number(PORT),
  path: '/webhook/stream', method: 'POST',
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-webhook-secret': sig },
  timeout: 60000
}, (res) => {
  let raw = '';
  res.on('data', (c)=>raw+=c);
  res.on('end', () => {
    const clean = sanitize(raw);
    process.stdout.write('TRIGGER http=' + res.statusCode + ' ' + clean + '\n');
    let ok = false;
    try { ok = JSON.parse(raw).ok === true; } catch {}
    process.exit(ok?0:1);
  });
});
req.on('error', (e)=>die('request error: '+e.message));
req.on('timeout', ()=>{req.destroy(); die('timeout (join/Go-Live did not settle within 60s)');});
req.end(body);
TRIGGER_EOF

# ============================================================================
# Launch the REAL bot (one worker `one`). The trigger uses the same HMAC the
# bot verifies against, keyed by $WEBHOOK_SECRET.
# ============================================================================
T0=$(date +%s)
export STREAMBOT_IDS=one
export STREAMBOT_DEFAULT_ID=one
export SELF_BOT_TOKEN="$SELF_BOT_TOKEN_ONE"
export SELF_BOT_TOKEN_ONE
export SBOT_GUILD_ID="$GUILD_ID"; export STREAM_CHANNEL_ID="$CHANNEL_ID"
export WEBHOOK_SECRET
export STREAMBOT_WEBHOOK_PORT=$PORT
export STREAMBOT_WEBHOOK_HOST=127.0.0.1
export STREAM_WIDTH=1920; export STREAM_HEIGHT=1080; export STREAM_FRAME_RATE=30
export SBOT_MAX_BITRATE_KBPS="${SBOT_MAX_BITRATE_KBPS:-8000}"
export VERBOSE=true; export SBOT_DEBUG=1
export SBOT_SOURCE_MAX_HEIGHT="${SBOT_SOURCE_MAX_HEIGHT:-1080}"
export SBOT_JITTER_BUFFER_SEC="${SBOT_JITTER_BUFFER_SEC:-4}"
export SBOT_FFMPEG_READ_TIMEOUT_MS="${SBOT_FFMPEG_READ_TIMEOUT_MS:-15000}"
export SBOT_PIPELINE_BUFFER_MB="${SBOT_PIPELINE_BUFFER_MB:-8}"
export SBOT_PIECE_WATCHDOG_SEC="${SBOT_PIECE_WATCHDOG_SEC:-30}"
export SBOT_SEND_STALL_SEC="${SBOT_SEND_STALL_SEC:-5}"
export SBOT_RECYCLE_MAX="${SBOT_RECYCLE_MAX:-2}"
export SBOT_RECYCLE_WINDOW_SEC="${SBOT_RECYCLE_WINDOW_SEC:-300}"
export STREAMBOT_PLAY_STREAM_TIMEOUT_MS="${STREAMBOT_PLAY_STREAM_TIMEOUT_MS:-60000}"
export SBOT_JOIN_VOICE_TIMEOUT_MS="${SBOT_JOIN_VOICE_TIMEOUT_MS:-30000}"
FFMPEG_CMD="$(command -v ffmpeg || echo /opt/homebrew/bin/ffmpeg)"
export FFMPEG_PATH="$FFMPEG_CMD"

echo "[sbx] launching bot with per-process caps node<${NODE_CAP_MIB}MiB ff<${FF_CAP_MIB}MiB wall=${RUN_SEC}s"
( cd "$ROOT" && exec env -u SELF_BOT_TOKEN \
    PATH="$PATH" \
    "$NODE_BIN" "$ROOT/src/streambot/supervisor.js" ) \
    > "$BOT_LOG" 2>&1 &
BOT_PID=$!
echo "bot=$BOT_PID" > "$PIDS"

# ---- wait for ready (up to 90s) ------------------------------------------------
READY=0
for ((h=1;h<=90;h++)); do
  kill -0 "$BOT_PID" 2>/dev/null || break
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
if [ "$READY" != 1 ]; then
  echo "[sbx] bot not ready; killing"
  kill_tree() { local p; kill -TERM "$1" 2>/dev/null || true; sleep 2; kill -9 "$1" 2>/dev/null || true; local kk; kk="$(pgrep -P "$1" 2>/dev/null || true)"; for p in $kk; do kill -9 "$p" 2>/dev/null || true; done; }
  ( kill_tree "$BOT_PID" ) || true
  pkill -9 -f ffmpeg 2>/dev/null || true
  {
    echo "# sbx VERDICT: NOT_READY"
    echo "bot failed to bring up webhook /health within 90s."
    echo; echo "## bot.log (tail)"
    tail -40 "$BOT_LOG" 2>/dev/null || echo "(none)"
  } > "$VERDICT"
  echo "RESULT=NOT_READY"
  exit 1
fi
echo "[sbx] bot ready, triggering ONCE (no auto-retry)"

# ---- trigger ONCE ---------------------------------------------------------------
SBX_TRIGGER_SECRET="$WEBHOOK_SECRET" \
SBX_TRIGGER_PORT="$PORT" \
GUILD_ID="$GUILD_ID" CHANNEL_ID="$CHANNEL_ID" MEDIA_URL="$MEDIA_URL" \
  "$NODE_BIN" "$TRIGGER"
TRIG_RC=$?
if [ "$TRIG_RC" -ne 0 ]; then
  kill_tree() { local p; kill -TERM "$1" 2>/dev/null || true; sleep 2; kill -9 "$1" 2>/dev/null || true; local kk; kk="$(pgrep -P "$1" 2>/dev/null || true)"; for p in $kk; do kill -9 "$p" 2>/dev/null || true; done; }
  kill_tree "$BOT_PID"; pkill -9 -f ffmpeg 2>/dev/null || true
  {
    echo "# sbx VERDICT: TRIGGER_FAILED (rc=$TRIG_RC)"
    echo "trigger returned non-zero -- the bot refused the stream request."
    echo; echo "## bot.log (tail)"
    tail -60 "$BOT_LOG" 2>/dev/null || echo "(none)"
  } > "$VERDICT"
  echo "RESULT=TRIGGER_FAILED"
  exit 2
fi
echo "[sbx] trigger OK, 30-min window starts, watching per-process memory"

# ---- watchdog (per-process caps) ----------------------------------------------
BOT_PID="$BOT_PID" BOT_LOG="$BOT_LOG" WLOG_PATH="$WLOG" STATE_PATH="$STATE" \
  NODE_CAP_MIB="$NODE_CAP_MIB" FF_CAP_MIB="$FF_CAP_MIB" \
  SAMPLE_S=3 WALL_CLOCK_LIMIT_S="$RUN_SEC" \
  bash "$OUT/watchdog.sh" &
WATCHDOG_PID=$!
echo "watchdog=$WATCHDOG_PID" >> "$PIDS"

# ---- wait for the watchdog to finish or the bot to die -------------------------
# The watchdog is the source of truth. It exits on:
#   - bot exits (natural stop)
#   - NODE_CAP or FF_CAP breached (SIGKILL the offending process; if bot)
#   - WALL_CLOCK_LIMIT_S reached
wait $WATCHDOG_PID 2>/dev/null || true
WATCHDOG_RC=$?

# ---- final state: extract from the black-box ----------------------------------
KILLED=0
grep -q 'WATCHDOG.*SIGKILL' "$WLOG" 2>/dev/null && KILLED=1
# peak per-process rss (max across all samples)
NODE_PEAK=0; FF_PEAK=0
while IFS= read -r line; do
  nm=$(echo "$line" | grep -oE 'node_max_mib=[0-9]+' | head -1 | sed 's/[^0-9]//g')
  fm=$(echo "$line" | grep -oE 'ff_max_mib=[0-9]+' | head -1 | sed 's/[^0-9]//g')
  [ -n "$nm" ] && [ "$nm" -gt "$NODE_PEAK" ] && NODE_PEAK="$nm"
  [ -n "$fm" ] && [ "$fm" -gt "$FF_PEAK" ] && FF_PEAK="$fm"
done < "$WLOG"
MAXOB=$(grep -aoE 'outBytes_total=[0-9]+' "$BOT_LOG" 2>/dev/null | sed 's/[^0-9]//g' | sort -n | tail -1); MAXOB=${MAXOB:-0}
DIST=$(grep -aoE 'outBytes_total=[0-9]+' "$WLOG" 2>/dev/null | sed 's/[^0-9]//g' | sort -u | wc -l | tr -d ' ')
RUN_S=$(( $(date +%s) - T0 ))
LEFT_FF=$(pgrep -fl ffmpeg 2>/dev/null | grep -v 'grep\|run_stress\|trigger\|zsh' || true)
LEFT_NODE=$(pgrep -fl 'streambot/|node.*index.js' 2>/dev/null | grep -v grep || true)

# ---- PASS / FAIL criteria ------------------------------------------------------
# PASS:
#   - ran >= 30 min (RUN_S >= 1800) OR (early stop with KILLED==1 and MAXOB > 50 MB => not possible, cap kill means FAIL)
#   - KILLED == 0 (no cap breach)
#   - MAXOB > 50_000_000 (frames actually delivered)
#   - DIST > 30 (samples advancing over time, not a single flat value)
#   - no leftover ffmpeg
# FAIL:
#   - KILLED == 1
#   - OR MAXOB < 50_000_000
#   - OR DIST <= 30 (flat)
#   - OR stray ffmpeg remains after clean stop

CLEAN_STOP=1
[ -n "$LEFT_FF" ] && CLEAN_STOP=0
[ -n "$LEFT_NODE" ] && CLEAN_STOP=0

PASS=1
[ "$KILLED" -eq 1 ] && PASS=0
[ "$MAXOB" -lt 50000000 ] && PASS=0
[ "$DIST" -le 30 ] && PASS=0
[ "$CLEAN_STOP" -ne 1 ] && PASS=0
[ "$RUN_S" -lt 1800 ] && PASS=0

if [ "$PASS" -eq 1 ]; then VERD="PASS"; else VERD="FAIL"; fi

# ---- final cleanup (safety net) ----------------------------------------------
kill -9 "$BOT_PID" 2>/dev/null || true
local_kill_tree() { local p; local kk; kk=$(pgrep -P "$1" 2>/dev/null || true); for p in $kk; do kill -9 "$p" 2>/dev/null || true; done; kill -9 "$1" 2>/dev/null || true; }
local_kill_tree "$BOT_PID" || true
pkill -9 -f ffmpeg 2>/dev/null || true
sleep 2
LEFT_FF_AFTER=$(pgrep -fl ffmpeg 2>/dev/null | grep -v 'grep\|run_stress\|trigger\|zsh' || true)
[ -n "$LEFT_FF_AFTER" ] && echo "WARNING: strays remain after cleanup: $LEFT_FF_AFTER" >> "$WLOG"

# ---- VERDICT.md -----------------------------------------------------------------
{
  echo "# sbx VERDICT: $VERD"
  echo
  echo "## summary"
  echo "run_s=$RUN_S killed=$KILLED node_peak_mib=$NODE_PEAK ff_peak_mib=$FF_PEAK node_cap_mib=$NODE_CAP_MIB ff_cap_mib=$FF_CAP_MIB"
  echo "max_outBytes_total=$MAXOB distinct_outBytes_samples=$DIST clean_stop=$CLEAN_STOP"
  echo "guild=$GUILD_ID channel=$CHANNEL_ID"
  echo "ffmpeg=$(command -v ffmpeg 2>/dev/null || echo none) node=$NODE_BIN"
  echo
  echo "## criteria"
  echo "- frames_delivered(max outBytes_${MAXOB} > 50 MB):  $([ "$MAXOB" -gt 50000000 ] && echo yes || echo no)"
  echo "- advancing_samples(distinct outBytes_${DIST} > 30): $([ "$DIST" -gt 30 ] && echo yes || echo no)"
  echo "- node_cap_not_breached:                            $([ "$NODE_PEAK" -lt "${NODE_CAP_MIB}" ] && echo yes | echo no)"
  echo "- ffmpeg_cap_not_breached:                          $([ "$FF_PEAK"  -lt "${FF_CAP_MIB}"  ] && echo yes | echo no)"
  echo "- no_process_killed:                                 $([ "$KILLED" -eq 0 ] && echo yes | echo no)"
  echo "- no_stray_ffmpeg_at_end:                             $([ "$CLEAN_STOP" -eq 1 ] && echo yes | echo no)"
  echo
  echo "## outBytes progression (from WLOG, every 3s)"
  grep -aE 't=[0-9]+s .* outBytes_total=[0-9]+' "$WLOG" 2>/dev/null | awk '{print $1, $0}' | awk '{for(i=1;i<=NF;i++) if($i ~ /outBytes_total=/||$i ~ /outBytes_1s=/||$i ~ /node_max_mib=/||$i ~ /ff_max_mib=/) printf "%s ", $i; print ""}' | head -40
  echo
  echo "## node & ffmpeg peaks by sample (WLOG, every 3s)"
  grep -aoE 'node_max_mib=[0-9]+ .* ff_max_mib=[0-9]+' "$WLOG" 2>/dev/null | tr ' ' '\n' | grep -oE '(node_max|ff_max)_mib=[0-9]+' | paste - - 2>/dev/null | head -40
  echo
  echo "## bot.log: key lines"
  grep -aE 'tel:|join|playStream|STREAM_CREATE|STREAM_SERVER_UPDATE|onStall|recycle|fatal|error|paused|readyState|broker|demux' "$BOT_LOG" 2>/dev/null | tail -40
  echo
  echo "## ffmpeg invocation (first line containing ffmpeg in bot.log)"
  grep -aE 'ffmpeg|/opt/homebrew/bin/ffmpeg' "$BOT_LOG" 2>/dev/null | head -3
} > "$VERDICT" 2>&1

sanitize
# Final check on strays.
pgrep -fl ffmpeg 2>/dev/null | grep -v 'grep\|run_stress\|trigger\|zsh' | head -3 || true
echo "RESULT=$VERD peak_node_mib=$NODE_PEAK peak_ff_mib=$FF_PEAK maxoutbytes=$MAXOB killed=$KILLED clean_stop=$CLEAN_STOP dist=$DIST run_s=$RUN_S"
exit 0
