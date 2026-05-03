#!/bin/bash
# Install git hooks for automatic GitHub sync after every commit.
# Run once after cloning: bash scripts/install-hooks.sh
set -e

HOOKS_DIR="$(git rev-parse --git-dir)/hooks"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

cat > "$HOOKS_DIR/post-commit" << 'HOOK'
#!/bin/bash
# Auto-push to GitHub after every commit.
if [ -z "$GITHUB_PAT" ]; then
  echo "[post-commit] GITHUB_PAT not set — skipping GitHub sync." >&2
  exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
bash "$REPO_ROOT/scripts/sync-github.sh" \
  && echo "[post-commit] Pushed to GitHub." \
  || echo "[post-commit] GitHub push failed (non-blocking)." >&2
exit 0
HOOK

chmod +x "$HOOKS_DIR/post-commit"
echo "post-commit hook installed at $HOOKS_DIR/post-commit"
echo "Every future commit will automatically push to GitHub (requires GITHUB_PAT to be set)."
