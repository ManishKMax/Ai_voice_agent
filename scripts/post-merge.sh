#!/bin/bash
set -e

pnpm install --frozen-lockfile
pnpm --filter db push

# Auto-install the GitHub sync post-commit hook so every future commit
# is automatically pushed to https://github.com/ManishKMax/Ai_voice_agent
bash "$(git rev-parse --show-toplevel)/scripts/install-hooks.sh"
