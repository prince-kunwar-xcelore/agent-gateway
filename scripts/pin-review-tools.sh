#!/usr/bin/env bash
# Pin the agent-gateway and pr-audit checkouts in review workflows to the current main commits.
# Each pinned SHA is followed on its line by a "# pin: <tool> main" comment, which is what this matches.
# Usage: scripts/pin-review-tools.sh <workflow.yml>...
set -euo pipefail
owner=prince-kunwar-xcelore
for tool in agent-gateway pr-audit; do
  sha=$(gh api "repos/$owner/$tool/commits/main" -q .sha)
  for f in "$@"; do
    perl -pi -e "s/[0-9a-f]{40}(.*# pin: \Q$tool\E main)/$sha\$1/" "$f"
  done
  echo "$tool → $sha"
done
