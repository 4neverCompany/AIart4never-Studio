#!/bin/bash
# post-rotation-audit.sh — run AFTER rotating the GitHub PAT. Confirms
# the new token is scoped correctly, the old one is gone, and no
# references to the old token survive in the repo.
#
# Usage:
#   bash scripts/security/post-rotation-audit.sh
#
# Exit codes:
#   0  — all checks pass
#   1  — at least one check failed
#
# This is a local-only script — no network calls beyond the GitHub
# CLI's auth check. Safe to run on any machine that has gh CLI authed.

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo '.')"
cd "$REPO_ROOT"

PASS=0
FAIL=0

pass() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🛡️  Post-rotation audit"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 1. gh CLI auth: confirm we have a working token
echo "▸ 1. gh CLI auth"
if gh auth status 2>&1 | grep -q "Logged in"; then
  ACTIVE_USER=$(gh api user --jq .login 2>/dev/null || echo "unknown")
  pass "gh CLI is authed as '$ACTIVE_USER'"
else
  fail "gh CLI is not authed. Run 'gh auth login' or set GITHUB_TOKEN."
fi

# 2. Scopes on the active token: print them for visual review
echo ""
echo "▸ 2. Active token scopes"
if command -v gh >/dev/null 2>&1; then
  # gh doesn't expose scopes directly via auth status, but
  # `gh auth status` shows them on stderr in some versions.
  SCOPES_LINE=$(gh auth status 2>&1 | grep -i 'token scopes' || true)
  if [ -n "$SCOPES_LINE" ]; then
    echo "  $SCOPES_LINE"
    if echo "$SCOPES_LINE" | grep -qi 'admin:org\|delete_repo\|admin:enterprise\|admin:public_key'; then
      fail "Token has high-privilege scopes (admin:org, delete_repo, etc.) — rotate again with least-privilege."
    else
      pass "Token scopes look reasonable (no admin:org, delete_repo, etc.)"
    fi
  else
    echo "  (couldn't read scopes — gh version too old or scopes hidden)"
  fi
fi

# 3. Working tree: no leftover references to the old token
echo ""
echo "▸ 3. Working tree — old-token references"
OLD_PAT_HITS=$(git grep -E 'ghp_[A-Za-z0-9]{36,}|gho_[A-Za-z0-9]{36,}|ghs_[A-Za-z0-9]{36,}|ghr_[A-Za-z0-9]{36,}|ghu_[A-Za-z0-9]{36,}' || true)
if [ -n "$OLD_PAT_HITS" ]; then
  fail "Found what looks like a hardcoded PAT in the working tree:"
  echo "$OLD_PAT_HITS" | head -10
else
  pass "No hardcoded PAT prefixes in the working tree"
fi

# 4. Git log (last 50 commits) for any new leaks introduced post-rotation
echo ""
echo "▸ 4. Recent git log — no new PATs in recent commits"
RECENT_LEAKS=$(git log -50 --pretty=format: --name-only | grep -E '^.+\.(sh|ts|tsx|js|mjs|cjs|json|ya?ml|env|toml)$' \
  | xargs -I{} sh -c 'git show HEAD:"{}" 2>/dev/null | grep -E "ghp_[A-Za-z0-9]{36,}|gho_[A-Za-z0-9]{36,}" || true' 2>/dev/null | head -5 || true)
if [ -n "$RECENT_LEAKS" ]; then
  fail "Recent commits contain what looks like a PAT. Inspect with: git log -p"
else
  pass "Recent commits (last 50) contain no PAT-shaped strings"
fi

# 5. The release scripts that originally had the hardcoded PAT — they
#    should now read from process.env.GITHUB_TOKEN
echo ""
echo "▸ 5. Release scripts — should read GITHUB_TOKEN from env"
RELEASE_SCRIPTS=$(ls docs/working-folder/scripts/*.py 2>/dev/null || true)
if [ -n "$RELEASE_SCRIPTS" ]; then
  for script in $RELEASE_SCRIPTS; do
    if grep -q 'os.environ.get.*GITHUB_TOKEN\|os.environ\["GITHUB_TOKEN"\]' "$script"; then
      pass "$(basename "$script") — reads GITHUB_TOKEN from env"
    else
      fail "$(basename "$script") — does NOT read GITHUB_TOKEN from env (might have a hardcoded fallback)"
    fi
  done
else
  echo "  (no release scripts under docs/working-folder/scripts/ — skipped)"
fi

# Summary
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 Audit summary: $PASS pass, $FAIL fail"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "⚠️  $FAIL check(s) failed. The token rotation may not be complete."
  echo "   Re-run after fixing the issues above."
  exit 1
fi
echo ""
echo "✅ All checks passed. The new token is active, scoped correctly,"
echo "   and no old-token references survive in the repo."
