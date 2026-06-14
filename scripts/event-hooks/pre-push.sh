#!/bin/sh
# scripts/event-hooks/pre-push.sh — emit a release event when a tag
# push hits the wire (remote-ref matches refs/tags/v*). Branch pushes
# are already covered by post-commit on the underlying commits.
# EVENT-LOG-AUTO-EMIT task.
#
# stdin: `<local-ref> <local-sha> <remote-ref> <remote-sha>` per ref.

LOG_SCRIPT="$HOME/.hermes/scripts/log-session-event.sh"
[ -x "$LOG_SCRIPT" ] || exit 0
[ "${SKIP_HERMES_HOOKS:-0}" = "1" ] && exit 0

while read -r local_ref local_sha remote_ref remote_sha; do
    case "$remote_ref" in
        refs/tags/v*)
            TAG="${remote_ref#refs/tags/}"
            "$LOG_SCRIPT" \
                --agent dev \
                --event release \
                --project MashupForge \
                --task "$TAG" \
                --summary "Release $TAG pushed to origin" \
                --detail "$local_sha" \
                >/dev/null 2>&1 || true
            ;;
    esac
done
exit 0
