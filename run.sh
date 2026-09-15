#!/bin/sh
set -e

# Single-launcher entrypoint. Boots both the CS2 real-bot ("bot") and the
# TV streaming selfbot ("streambot") in the SAME container/entrypoint so the
# repo stays one deployable unit.
#
# MODE (env): all (default) | bot | streambot
#   - "bot"       → only the CS2 real-bot (existing behavior)
#   - "streambot" → only the TV streaming selfbot
#   - "all"       → both; SELF_BOT_TOKEN is ignored if unset (bot only)
#   - "help"      → print usage and exit

MODE="${MODE:-all}"

log() { printf '[launcher] %s\n' "$*"; }
die() { printf '[launcher] ERROR: %s\n' "$1" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: MODE=all|bot|streambot run.sh

MODE=all (default)     run the CS2 real-bot AND the TV streaming selfbot.
MODE=bot               run only the CS2 real-bot (legacy behavior).
MODE=streambot         run only the TV streaming selfbot.
EOF
}

case "$MODE" in
  help|-h|--help)
    usage
    exit 0
    ;;
  bot)
    log "MODE=bot → starting CS2 real-bot only"
    exec node src/index.js
    ;;
  streambot)
    log "MODE=streambot → starting TV streaming selfbot only"
    exec node src/streambot/index.js
    ;;
  all)
    log "MODE=all → running CS2 real-bot + TV streaming selfbot concurrently"
    log "  - bot:         node src/index.js"
    if [ -n "${SELF_BOT_TOKEN:-}" ]; then
      log "  - streambot:   node src/streambot/index.js"
      # Both foreground, one process each. The container's main process is
      # this script; when either dies the shell (with set -e) will wait.
      # Use `wait` on both; trap to kill the sibling on exit.
      (
        set -m
        node src/index.js &
        PID_BOT=$!
        node src/streambot/index.js &
        PID_SBOT=$!
        trap 'kill $PID_BOT $PID_SBOT 2>/dev/null' INT TERM EXIT
        # Exit with the first non-zero exit code, or 0 if both clean.
        RC=0
        wait $PID_BOT || RC=$?
        wait $PID_SBOT || RC=$?
        exit $RC
      )
      exit $?
    else
      log "SELF_BOT_TOKEN unset → streambot not started; running CS2 bot only"
      exec node src/index.js
    fi
    ;;
  *)
    usage
    die "unknown MODE '$MODE' (expected: all | bot | streambot)"
    ;;
esac
