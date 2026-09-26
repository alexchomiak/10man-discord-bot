#!/bin/sh
set -e

MODE="${MODE:-all}"
case "$MODE" in
  help|-h|--help)
    cat <<'USAGE'
Usage: MODE=all|bot|streambot run.sh

MODE=all (default)     run the CS2 real-bot AND configured TV streaming workers.
MODE=bot               run only the CS2 real-bot.
MODE=streambot         run TV streaming worker(s).
USAGE
    exit 0
    ;;
  all|bot|streambot)
    export MODE
    exec node src/processSupervisor.js
    ;;
  *)
    printf '[launcher] ERROR: unknown MODE %s\n' "$MODE" >&2
    exit 1
    ;;
esac
