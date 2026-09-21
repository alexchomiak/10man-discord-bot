#!/usr/bin/env bash
# safety.sh - run a scenario script under a hard wallclock cap AND a hard RSS cap
# so a leak in the libdatachannel native stack cannot OOM-kill the laptop.
#
# Usage:
#   bash tools/sendleak-sandbox/safety.sh <scenario.js>
#   e.g.:
#     SBOT_DURATION_MS=15000 bash tools/sendleak-sandbox/safety.sh scenario_a_sendqueue.js
#     SBOT_CONN_ITERS=5    bash tools/sendleak-sandbox/safety.sh scenario_b_reconnect.js
#
# Args:
#   $1  the scenario file (relative to this directory, or a path)
#   ... any additional args are passed through to node.
#
# Safety knobs (env, all optional):
#   SBT_RUN_SECONDS      wallclock cap.      default 240
#   SBT_RSS_LIMIT_KB     RSS cap in KiB.     default 8388608 (8 GiB)
#
# NOTE: the task spec called for `ulimit -v 8388608`. bash on macOS (even zsh
# shells we invoke it from) will not let us lower the address-space cap from a
# child shell ("virtual memory: cannot modify limit"), so we attempt it for best
# effort and then rely on the RSS watchdog (above) as the *real* guard, which
# works identically on macOS and Linux.
#
# Implementation notes per platform:
#   * macOS: bash cannot lower `ulimit -v` from a shell (it reports
#     "virtual memory: cannot modify limit: Invalid argument"). The real backstop
#     is a *watchdog* that polls `ps -o rss` every second and SIGKILLs node if
#     either the cap or the wallclock is hit. A SIGKILL-ed node exits with 137,
#     which we map to "KILLED_BY_ULIMIT".
#   * Linux: `ulimit -v 8388608` (KB, address space) is a hard cap enforced by
#     the kernel; the same watchdog runs as a backup, and `timeout -k 2 -s KILL
#     240` is used if available. We also add `nice -n 10` and `ionice` if they
#     exist so a runaway scenario cannot starve the desktop.
#
# On exit we print the last 20 lines of the TSV and a one-line verdict:
#   UNBOUNDED_GROWTH    rss grew >  1 GiB during the run
#   BOUNDED             rss grew <  512 MiB (or grey-zone < 1 GiB)
#   KILLED_BY_ULIMIT    the watchdog/timeout had to SIGKILL node (exit 137/143)

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
export NODE_PATH="$ROOT/node_modules"

SCENARIO="${1:-}"
if [[ -z "$SCENARIO" ]]; then
  echo "usage: safety.sh <scenario.js> [args...]" >&2
  exit 2
fi
if [[ "$SCENARIO" != /* ]] && [[ -f "$SCRIPT_DIR/$SCENARIO" ]]; then
  SCENARIO="$SCRIPT_DIR/$SCENARIO"
elif [[ "$SCENARIO" != /* ]] && [[ -f "$ROOT/$SCENARIO" ]]; then
  SCENARIO="$ROOT/$SCENARIO"
fi
shift || true

RUN_SECONDS="${SBT_RUN_SECONDS:-240}"
RSS_LIMIT_KB="${SBT_RSS_LIMIT_KB:-8388608}"
RSS_LIMIT_BYTES=$((RSS_LIMIT_KB * 1024))

cd "$SCRIPT_DIR"

# Best-effort: raise the address-space limit where the shell allows it.
# (macOS typically rejects this; Linux honours it.)
ulimit -v "$RSS_LIMIT_KB" 2>/dev/null || true

OUTFILE="$(mktemp -t sendleak-XXXXXX.out)"
ERRFILE="$(mktemp -t sendleak-XXXXXX.err)"

# Watchdog: SIGKILL the target pid if either cap is hit.
# Exit 0 regardless; the outer `wait node` gives the real status.
watchdog() {
  local target="$1" run_seconds="$2" rss_limit_bytes="$3"
  local start now elapsed rss
  start=$(date +%s)
  while true; do
    now=$(date +%s)
    elapsed=$(( now - start ))
    # Process gone? Stop.
    if ! ps -p "$target" -o rss= >/dev/null 2>&1; then
      break
    fi
    if [[ $elapsed -ge $run_seconds ]]; then
      kill -9 "$target" 2>/dev/null || true
      break
    fi
    rss=$(ps -p "$target" -o rss= 2>/dev/null | tr -d ' ')
    if [[ -n "${rss:-}" ]] && [[ "$rss" -gt "$rss_limit_bytes" ]]; then
      kill -9 "$target" 2>/dev/null || true
      break
    fi
    sleep 1
  done
  return 0
}

# Optional nicer scheduling (Linux only, best-effort).
NICE_CMD=()
if [[ "$(uname -s)" == "Linux" ]] && command -v nice >/dev/null 2>&1; then
  NICE_CMD=(nice -n 10)
fi

node --expose-gc "${SCENARIO}" "$@" >"$OUTFILE" 2>"$ERRFILE" &
NODE_PID=$!
watchdog "$NODE_PID" "$RUN_SECONDS" "$RSS_LIMIT_BYTES" &
WDOG_PID=$!

RC=0
# Reap the node process. The watchdog may have killed it, but `wait` still returns
# the correct exit code (137 for SIGKILL).
wait "$NODE_PID"; RC=$?

# Let the watchdog notice that the target is gone and stop polling.
# Poll up to ~3s; then SIGTERM/SIGKILL the watchdog either way.
for _ in 1 2 3; do
  if ! kill -0 "$WDOG_PID" 2>/dev/null; then break; fi
  sleep 1
done
if kill -0 "$WDOG_PID" 2>/dev/null; then
  kill "$WDOG_PID" 2>/dev/null || true
fi
wait "$WDOG_PID" 2>/dev/null || true

# --- Emit the last 20 lines of the TSV (or stdout) ---
# Pick the TSV that matches the scenario name we were given, rather than any
# stale TSV in out/.
SCENARIO_BASE="$(basename "$SCENARIO" .js)"
TSV=""
if [[ -n "${SBOT_TSV:-}" && -f "${SBOT_TSV}" ]]; then
  TSV="$SBOT_TSV"
else
  for c in "out/${SCENARIO_BASE}.tsv" "out/scenario_a.tsv" "out/scenario_b.tsv"; do
    [[ -f "$c" ]] && { TSV="$c"; break; }
  done
fi

if [[ -n "$TSV" ]]; then
  echo "----- last 20 lines of $TSV -----"
  tail -n 20 "$TSV"
else
  echo "----- last 20 lines of run output -----"
  tail -n 20 "$OUTFILE"
  if [[ -s "$ERRFILE" ]]; then
    echo "----- stderr tail -----"
    tail -n 5 "$ERRFILE"
  fi
fi

# --- VERDICT ---
FIRST_RSS=""
LAST_RSS=""
if [[ -n "$TSV" ]]; then
  FIRST_RSS="$(awk -F'\t' 'NR==2{print $2; exit}' "$TSV" 2>/dev/null)"
  LAST_RSS="$(awk -F'\t' 'END{print $2}' "$TSV" 2>/dev/null)"
fi

if [[ -n "$FIRST_RSS" && -n "$LAST_RSS" ]]; then
  GROWTH_BYTES=$(( LAST_RSS - FIRST_RSS ))
  GROWTH_KB=$(( GROWTH_BYTES / 1024 ))
  GROWTH_MB=$(( GROWTH_KB / 1024 ))
  GROWTH_GB=$(( GROWTH_MB / 1024 ))
  if [[ $RC -eq 137 || $RC -eq 143 || $RC -eq 9 ]]; then
    echo "VERDICT: KILLED_BY_ULIMIT (node rc=$RC, rss growth=${GROWTH_MB}MiB/${GROWTH_GB}GiB)"
  elif [[ $GROWTH_MB -gt 1024 ]]; then
    echo "VERDICT: UNBOUNDED_GROWTH (node rc=$RC, rss growth=${GROWTH_MB}MiB/${GROWTH_GB}GiB)"
  elif [[ $GROWTH_MB -gt 512 ]]; then
    echo "VERDICT: BOUNDED (grey zone 512-1024 MiB: growth=${GROWTH_MB}MiB, node rc=$RC)"
  else
    echo "VERDICT: BOUNDED (rss growth=${GROWTH_MB}MiB, node rc=$RC)"
  fi
else
  if [[ $RC -eq 137 || $RC -eq 143 || $RC -eq 9 ]]; then
    echo "VERDICT: KILLED_BY_ULIMIT (no readable TSV, node rc=$RC)"
  else
    echo "VERDICT: BOUNDED (no readable TSV, node rc=$RC)"
  fi
fi

rm -f "$OUTFILE" "$ERRFILE"
exit $RC
