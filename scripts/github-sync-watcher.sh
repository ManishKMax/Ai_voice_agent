#!/bin/bash
# Continuously watches for new commits on the main branch and pushes them
# to GitHub automatically. Runs as a Replit background workflow.
# Requires GITHUB_PAT environment variable to be set.

set -euo pipefail

REPO_URL="https://ManishKMax@github.com/ManishKMax/Ai_voice_agent.git"
POLL_INTERVAL=10  # seconds between checks
LAST_SYNCED=""

if [ -z "${GITHUB_PAT:-}" ]; then
  echo "[github-sync] ERROR: GITHUB_PAT is not set. Exiting." >&2
  exit 1
fi

echo "[github-sync] Watcher started. Polling every ${POLL_INTERVAL}s for new commits on main."

push_to_github() {
  local ASKPASS
  ASKPASS=$(mktemp)
  trap 'rm -f "$ASKPASS"' RETURN
  printf '#!/bin/bash\necho "%s"\n' "$GITHUB_PAT" > "$ASKPASS"
  chmod +x "$ASKPASS"
  GIT_ASKPASS="$ASKPASS" git push "$REPO_URL" main 2>&1
}

while true; do
  CURRENT=$(git -C "$(git rev-parse --show-toplevel)" rev-parse main 2>/dev/null || true)

  if [ -n "$CURRENT" ] && [ "$CURRENT" != "$LAST_SYNCED" ]; then
    echo "[github-sync] New commit detected: ${CURRENT:0:7}. Pushing to GitHub..."
    if push_to_github; then
      echo "[github-sync] Pushed successfully: ${CURRENT:0:7}"
      LAST_SYNCED="$CURRENT"
    else
      echo "[github-sync] Push failed — will retry in ${POLL_INTERVAL}s." >&2
    fi
  fi

  sleep "$POLL_INTERVAL"
done
