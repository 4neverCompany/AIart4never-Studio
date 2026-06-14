#!/bin/bash
# rotate-github-pat.sh — one-shot helper for the GitHub PAT rotation
# the handoff flagged at commit fcb30d3.
#
# What this does:
#   1. Verifies gitleaks is installed (if not, refuses to continue —
#      the user's whole point of this rotation is to prevent future leaks).
#   2. Greps the local working tree for the OLD PAT prefix. If found,
#      the rotation isn't safe to do automatically — abort with
#      instructions.
#   3. Prints the step-by-step instructions Maurice needs to do on
#      GitHub.com to actually rotate the token. The actual rotation
#      requires GitHub.com web auth (we don't have admin-level auth
#      from the CLI), so this script is a guide + pre-flight check,
#      not an automated rotation.
#
# Usage:
#   bash scripts/security/rotate-github-pat.sh [--dry-run]
#
# Exit codes:
#   0  — pre-flight clean, ready to rotate
#   1  — leaked PAT still in the tree, abort and clean it first
#   2  — gitleaks not installed, install first
#
# After running this and following the printed steps, also run:
#   bash scripts/security/post-rotation-audit.sh
# to confirm the new token is scoped correctly and the old one is gone.

set -euo pipefail

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo '.')"
cd "$REPO_ROOT"

# --- 1. gitleaks present? ---
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "❌ gitleaks not installed. Install it first:"
  echo "     brew install gitleaks    # macOS"
  echo "     scoop install gitleaks  # Windows"
  echo "     bun add -D gitleaks     # local dev"
  exit 2
fi

# --- 2. Scan working tree for any committed PAT ---
echo "🔍 Scanning working tree for any PAT-shaped strings..."
LEAK_HITS=$(gitleaks detect --source . --no-banner --redact 2>&1 || true)
if echo "$LEAK_HITS" | grep -qi 'leaks found'; then
  echo "❌ gitleaks still finds leaks in the working tree. Aborting."
  echo "   The leaked PAT must be removed from git history BEFORE we"
  echo "   rotate the new one, otherwise the rotation is meaningless."
  echo ""
  echo "   Detected:"
  echo "$LEAK_HITS" | head -40
  echo ""
  echo "   To clean:"
  echo "     1. Identify the offending file:line above"
  echo "     2. Replace the literal with an env-var read (e.g. process.env.GH_TOKEN)"
  echo "     3. git rm --cached <file>  (if the file is already tracked)"
  echo "     4. git commit --amend --no-edit  (rewrite the last commit)"
  echo "     5. For a deep-history leak: gitleaks protect --staged --redact"
  echo "        + git filter-repo to rewrite history (coordinate with team)"
  exit 1
fi

echo "✅ Working tree is clean — no PAT-shaped strings found."
echo ""

# --- 3. Print the actual rotation steps ---
cat <<'EOF'
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛡️  GitHub PAT Rotation — Manual Steps on GitHub.com
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

The actual rotation requires browser auth on GitHub.com. Do these
in order:

  1. Open https://github.com/settings/tokens
     (Settings → Developer settings → Personal access tokens → Tokens
      (classic)) — Maurice's account, NOT the org bot.

  2. Find the leaked token. The handoff §commit fcb30d3 says it had
     "full repo access" on 4neverCompany/MashupForge. The token
     description will likely reference the project name or the
     "release-body" use case (one of the superseded release scripts
     in docs/working-folder/scripts/).

  3. Click the token → "Delete" → confirm. This REVOKES the token
     immediately. Any running process using the old token will
     start failing on its next API call.

  4. Click "Generate new token" → "Generate new token (classic)":
       - Note:    "MashupForge local dev — YYYY-MM-DD"
       - Expiration: 90 days (set a calendar reminder for rotation)
       - Scopes:   ONLY what local dev needs:
                     ✓ repo    (full control of private repositories)
                     ✓ workflow (update GitHub Actions workflows)
                   DO NOT enable admin:org, delete_repo, or anything
                   else. Principle of least privilege.

  5. Copy the new token (you'll only see it once — ghp_…).

  6. Update local env / secrets manager:
       Linux/macOS:  echo 'export GITHUB_TOKEN=ghp_NEW…' >> ~/.zshrc
       Windows (PowerShell):
                     [Environment]::SetEnvironmentVariable('GITHUB_TOKEN','ghp_NEW…','User')
       Or: paste it into your password manager (1Password / Bitwarden)

  7. Update any local `.env` file in this repo IF you use one
     (DO NOT commit it). The release scripts already read
     process.env.GITHUB_TOKEN, so no code change needed.

  8. Verify the new token works:
       gh auth status
       (it should show your new token is active)

  9. Run the post-rotation audit (separate script):
       bash scripts/security/post-rotation-audit.sh

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
After completing the above, the rotation is done. The CI workflow
`.github/workflows/secret-scan.yml` will catch any future leaks.
EOF

if [ "$DRY_RUN" = "1" ]; then
  echo ""
  echo "(dry-run mode — no actual checks performed, just printed the guide)"
fi
