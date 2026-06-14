#!/bin/sh
# scripts/event-hooks/post-merge.sh — emit a note event when upstream
# changes are absorbed via `git pull` / `git merge`. Catches ff-pulls
# that don't fire post-commit. EVENT-LOG-AUTO-EMIT task.

LOG_SCRIPT="$HOME/.hermes/scripts/log-session-event.sh"
[ -x "$LOG_SCRIPT" ] || exit 0
[ "${SKIP_HERMES_HOOKS:-0}" = "1" ] && exit 0

HEAD_SHA=$(git rev-parse HEAD 2>/dev/null) || exit 0
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || exit 0
SUBJECT=$(git log -1 --format=%s HEAD 2>/dev/null) || exit 0

"$LOG_SCRIPT" \
    --agent dev \
    --event note \
    --project MashupForge \
    --task "merge" \
    --summary "Merged upstream into ${BRANCH}: ${SUBJECT}" \
    --detail "$HEAD_SHA" \
    >/dev/null 2>&1 || true
exit 0
