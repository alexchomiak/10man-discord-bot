#!/usr/bin/env bash
# watchdog.sh -- per-process (node + ffmpeg) memory guardian for the sandbox.
#
# Contract:
# - Sample the BOT's node process tree and each ffmpeg child every SAMPLE_S.
# - Write to a black-box (WLOG_PATH) per sample: t= s, rss bytes and MiB per
#   process, outBytes_total, producer_buf, el_p99_ms from bot.log.
# - If any single process exceeds its cap (NODE_CAP_MIB for node, FF_CAP_MIB
#   for ffmpeg), SIGKILL it and set KILLED to 1, write WLOG + state.
# - Never kill the whole tree based on a sum. If one process is well-behaved
#   the other is allowed to run.
#
# Required env:
#   BOT_PID        (pid of node supervisor, which owns index.js workers)
#   BOT_LOG        path to the bot's stdout/stderr file (for tel: extraction)
#   WLOG_PATH      blackbox log path (append-only)
#   STATE_PATH     atomic state.json path
#   NODE_CAP_MIB   (default 4096)
#   FF_CAP_MIB     (default 8192)
#   SAMPLE_S       (default 3)
#
# Returns 0 on natural stop (bot exits), 1 on a cap kill.
#
# Never kills ffmpeg based on node memory, and never kills node based on
# ffmpeg memory. Each process has its own cap; each process is judged on its
# own usage.

# ---- helpers -----------------------------------------------------------------
set -u

# Walk descendants of $1 using pgroup. On macOS, `ps -o ppid=` returns the
# parent. We walk down with pgrep -P.
descendants() {
  local root="$1"
  local out=()
  _desc() {
    local c
    local kids; kids="$(pgrep -P "${1}" 2>/dev/null || true)"
    if [ -n "$kids" ]; then
      for c in $kids; do
        out+=("$c")
        _desc "$c"
      done
    fi
  }
  _desc "$root"
  # shellcheck disable=SC2034
  printf '%s\n' "${out[@]}" 2>/dev/null || true
}

# rss_bytes <pid> : resident set size in bytes (macOS: KiB * 1024)
rss_bytes_of() {
  local k
  k=$(ps -o rss= -p "$1" 2>/dev/null | tr -d ' ')
  [ -n "${k:-}" ] && echo $(( k * 1024 )) || echo 0
}

# cmd_of <pid> : the full command line
cmd_of() {
  ps -o command= -p "$1" 2>/dev/null || echo ""
}

classify() {
  # Print classification for $1: "node" / "ffmpeg" / "other"
  local p="$1"
  local cmdline
  cmdline="$(cmd_of "$p")"
  case "$cmdline" in
    *ffmpeg*)        echo "ffmpeg" ;;
    */node*index.js*|*src/streambot/index.js*|*node*supervisor.js*|*src/streambot/supervisor.js*) echo "node" ;;
    *node*)          echo "node" ;;   # default for anything with "node" in name
    *)               echo "other" ;;
  esac
}

# ---- init --------------------------------------------------------------------
BOT_PID="${BOT_PID:?env BOT_PID required}"
BOT_LOG="${BOT_LOG:?env BOT_LOG required}"
WLOG="${WLOG_PATH:?env WLOG_PATH required}"
STATE="${STATE_PATH:?env STATE_PATH required}"
NODE_CAP_MIB="${NODE_CAP_MIB:-4096}"
FF_CAP_MIB="${FF_CAP_MIB:-8192}"
SAMPLE_S="${SAMPLE_S:-3}"
NODE_CAP_BYTES=$(( NODE_CAP_MIB * 1024 * 1024 ))
FF_CAP_BYTES=$(( FF_CAP_MIB * 1024 * 1024 ))
KILLED=0
T0=$(date +%s)   # wall clock at start of this watchdog (not of bot launch)
WALL_CLOCK_LIMIT_S="${WALL_CLOCK_LIMIT_S:-1800}"   # hard stop after 30 min

# Black-box line helper.
wlog() {
  local msg="$1"
  local line
  line="$(date '+%Y-%m-%dT%H:%M:%S') $msg"
  printf '%s\n' "$line" >> "$WLOG" 2>/dev/null || true
  sync >/dev/null 2>&1 || true
}

# Latest tel: field extractor (last tel: line in bot.log).
last_tel_field() {
  local field="$1"
  # Pull the LATEST tel: line (bot.log is append-only), then that field.
  grep -a 'tel:' "$BOT_LOG" 2>/dev/null | tail -1 \
    | grep -aoE "${field}=[^ ]+" \
    | sed -E "s/${field}=//" \
    | tr -d ' ' || true
}

# ---- atomic state ------------------------------------------------------------
write_state() {
  local t_s="$1" node_mib="$2" ff_mib="$3" obl="$4" el_p99="$5" ob_1s="$6"
  local tmp="${STATE}.tmp"
  printf '{"t_s":%s,"node_mib":%s,"ffmpeg_mib":%s,"outBytes_total":"%s","el_p99":"%s","outBytes_1s":"%s","killed":%s,"node_cap_mib":%s,"ff_cap_mib":%s}\n' \
    "${t_s}" "${node_mib}" "${ff_mib}" "${obl}" "${el_p99}" "${ob_1s}" "$KILLED" "$NODE_CAP_MIB" "$FF_CAP_MIB" \
    > "$tmp" 2>/dev/null || return
  mv -f "$tmp" "$STATE" 2>/dev/null || true
}

# ---- kill helpers ------------------------------------------------------------
kill_pid() {
  local p="$1" sig="$2"
  kill "-$sig" "$p" 2>/dev/null || true
}
kill_tree() {
  local root="$1" sig="$2"
  local p
  kill_pid "$root" "$sig"
  local kids; kids="$(pgrep -P "$root" 2>/dev/null || true)"
  for p in $kids; do kill_pid "$p" "$sig"; done
  # one more level
  for p in $kids; do
    local kk; kk="$(pgrep -P "$p" 2>/dev/null || true)"
    for p2 in $kk; do kill_pid "$p2" "$sig"; done
  done
}

# ---- main loop ---------------------------------------------------------------
wlog "=== watchdog pid_of_bot=$BOT_PID cap node=${NODE_CAP_MIB}MiB ff=${FF_CAP_MIB}MiB sample=${SAMPLE_S}s wallclock=${WALL_CLOCK_LIMIT_S}s ==="
END_AT=$(( $(date +%s) + WALL_CLOCK_LIMIT_S ))
while kill -0 "$BOT_PID" 2>/dev/null && [ "$(date +%s)" -lt "$END_AT" ]; do
  NOW=$(( $(date +%s) - T0 ))

  # Discover node processes (bot + supervisor) and ffmpeg processes.
  NODE_PIDS=""
  FF_PIDS=""
  # Direct children first (bot may be supervisor; index.js is child; ffmpeg is grandchild).
  pids_to_check="$BOT_PID"
  # Add direct children and grandchildren.
  pids_to_check="$pids_to_check $(pgrep -P "$BOT_PID" 2>/dev/null || true)"
  for p in $(pgrep -P "$BOT_PID" 2>/dev/null | tr '\n' ' '); do
    pids_to_check="$pids_to_check $(pgrep -P "$p" 2>/dev/null | tr '\n' ' ')"
  done
  for p in $(echo "$pids_to_check" | tr ' ' '\n' | sort -u); do
    [ -z "$p" ] && continue
    kill -0 "$p" 2>/dev/null || continue
    cls="$(classify "$p")"
    case "$cls" in
      node)   NODE_PIDS="$NODE_PIDS $p" ;;
      ffmpeg) FF_PIDS="$FF_PIDS $p" ;;
      *)      : ;;   # other (zsh, curl, etc.) -- ignore
    esac
  done

  # Max node rss and max ffmpeg rss (bytes), and per-pid lines.
  NODE_MAX_B=0; FF_MAX_B=0
  node_mib_sum=0; ff_mib_sum=0
  NODE_DETAIL=""; FF_DETAIL=""
  for p in $NODE_PIDS; do
    b=$(rss_bytes_of "$p"); mib=$(( b / 1024 / 1024 ))
    node_mib_sum=$(( node_mib_sum + mib ))
    # max (single process is what matters -- no process should exceed the cap)
    [ "$b" -gt "$NODE_MAX_B" ] && NODE_MAX_B="$b"
    NODE_DETAIL="${NODE_DETAIL} pid=${p} rss_mib=${mib}"
  done
  for p in $FF_PIDS; do
    b=$(rss_bytes_of "$p"); mib=$(( b / 1024 / 1024 ))
    ff_mib_sum=$(( ff_mib_sum + mib ))
    [ "$b" -gt "$FF_MAX_B" ] && FF_MAX_B="$b"
    FF_DETAIL="${FF_DETAIL} pid=${p} rss_mib=${mib}"
  done
  NODE_MAX_MIB=$(( NODE_MAX_B / 1024 / 1024 ))
  FF_MAX_MIB=$(( FF_MAX_B / 1024 / 1024 ))
  ob_total=$(last_tel_field "outBytes_total")
  ob_1s=$(last_tel_field "outBytes_1s")
  el_p99=$(last_tel_field "el_p99_ms")
  pp_buf=$(last_tel_field "producer_buf")
  ob_total=${ob_total:-0}; ob_1s=${ob_1s:-0}; el_p99=${el_p99:-n/a}; pp_buf=${pp_buf:-0}

  wlog "t=${NOW}s node_max_mib=${NODE_MAX_MIB} node_detail=${NODE_DETAIL:-none} ff_max_mib=${FF_MAX_MIB} ff_detail=${FF_DETAIL:-none} outBytes_total=${ob_total} outBytes_1s=${ob_1s} producer_buf=${pp_buf} el_p99_ms=${el_p99}"
  write_state "$NOW" "$NODE_MAX_MIB" "$FF_MAX_MIB" "${ob_total}" "${el_p99}" "${ob_1s}"

  # CAP ENFORCEMENT. Kill any SINGLE process exceeding its cap, but only
  # escalate to a full-tree kill if the process is the bot itself (so we don't
  # leave orphans).
  if [ "$NODE_MAX_B" -gt "$NODE_CAP_BYTES" ]; then
    wlog "WATCHDOG node rss $NODE_MAX_B B > cap $NODE_CAP_BYTES B -- SIGKILL node tree"
    KILLED=1
    # Identify the offending pid if we have it.
    for p in $NODE_PIDS; do
      b=$(rss_bytes_of "$p"); [ "$b" -gt "$NODE_CAP_BYTES" ] && kill_pid "$p" 9
    done
    # then stop the bot so we don't keep spawning ffmpeg.
    kill_tree "$BOT_PID" 9
    break
  fi
  if [ "$FF_MAX_B" -gt "$FF_CAP_BYTES" ]; then
    wlog "WATCHDOG ffmpeg rss $FF_MAX_B B > cap $FF_CAP_BYTES B -- SIGKILL ffmpeg"
    KILLED=1
    for p in $FF_PIDS; do
      b=$(rss_bytes_of "$p"); [ "$b" -gt "$FF_CAP_BYTES" ] && kill_pid "$p" 9
    done
    # don't kill the bot -- one offending ffmpeg killed is enough.
    # if bot keeps spawning new ffmpeg, the next sample will catch it.
  fi

  sleep "$SAMPLE_S"
done

# Natural stop.
KILL_REASON=""
[ "$KILLED" -eq 0 ] && kill -0 "$BOT_PID" 2>/dev/null && KILL_REASON="wallclock ${WALL_CLOCK_LIMIT_S}s reached"
write_state "$(( $(date +%s) - T0 ))" 0 0 0 0 0 "$KILLED"
wlog "=== watchdog stop killed=$KILLED reason=${KILL_REASON:-bot-exited} ==="
# Cleanup any remaining children.
if kill -0 "$BOT_PID" 2>/dev/null; then
  kill_tree "$BOT_PID" 15
  sleep 2
  kill_tree "$BOT_PID" 9 || true
fi
# Kill any stray ffmpeg (safety net).
pkill -9 -f ffmpeg 2>/dev/null || true
exit 0
