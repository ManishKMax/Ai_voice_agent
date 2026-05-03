#!/bin/bash
# Push the main branch to GitHub.
# Uses GIT_ASKPASS so credentials are never embedded in URLs or stored in .git/config.
# A trap ensures the temp askpass file is always removed, even on failure.
set -e

if [ -z "$GITHUB_PAT" ]; then
  echo "Error: GITHUB_PAT environment variable is not set." >&2
  exit 1
fi

REPO_URL="https://ManishKMax@github.com/ManishKMax/Ai_voice_agent.git"

ASKPASS=$(mktemp)
trap 'rm -f "$ASKPASS"' EXIT

printf '#!/bin/bash\necho "%s"\n' "$GITHUB_PAT" > "$ASKPASS"
chmod +x "$ASKPASS"

GIT_ASKPASS="$ASKPASS" git push "$REPO_URL" main

echo "Successfully synced main to GitHub: $REPO_URL"
