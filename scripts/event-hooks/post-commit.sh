#!/bin/sh
# scripts/event-hooks/post-commit.sh — auto-emit a commit event to
# ~/.hermes/sessions/project-events.jsonl. EVENT-LOG-AUTO-EMIT task.
#
# Invoked by simple-git-hooks (declared in package.json), which installs
# the actual .git/hooks/post-commit to shell out here. Living in-tree
# means `npm install` / `bash scripts/release.sh` won't wipe the logic
# (the previous standalone .git/hooks/post-commit got nuked because
# simple-git-hooks removes hooks not in its config every install).
#
# Best-effort — must NEVER fail the surrounding git operation.

LOG_SCRIPT="$HOME/.hermes/scripts/log-session-event.sh"
[ -x "$LOG_SCRIPT" ] || exit 0
[ "${SKIP_HERMES_HOOKS:-0}" = "1" ] && exit 0

SHA=$(git rev-parse HEAD 2>/dev/null) || exit 0
SUBJECT=$(git log -1 --format=%s HEAD 2>/dev/null) || exit 0
# Extract first UPPERCASE-WITH-DASHES task-id-shaped token (>=4 chars,
# must end alphanumeric). Catches UPDATE-P0-1, EVENT-LOG-AUTO-EMIT,
# DEPS-PATCH-MINOR-MAY22, V091-DEV-002 etc.
TASK=$(printf '%s' "$SUBJECT" | grep -oE '[A-Z][A-Z0-9-]{3,}[A-Z0-9]' | head -1)

"$LOG_SCRIPT" \
    --agent dev \
    --event commit \
    --project MashupForge \
    --task "${TASK:-}" \
    --summary "$SUBJECT" \
    --detail "$SHA" \
    >/dev/null 2>&1 || true
exit 0
