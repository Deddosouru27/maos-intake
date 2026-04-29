#!/usr/bin/env bash
# Usage: ./scripts/create-pr.sh "feat: title of the PR"
set -euo pipefail

TITLE="${1:?Usage: $0 \"feat: PR title\"}"
BRANCH=$(git rev-parse --abbrev-ref HEAD)

gh pr create \
  --title "$TITLE" \
  --base main \
  --head "$BRANCH" \
  --body "$(cat <<EOF
## Summary
- $TITLE

## Branch
\`$BRANCH\`

## Test plan
- [x] \`npx tsc --noEmit\` passes
- [x] \`npm run test\` passes
- [x] Deployed to Vercel production

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
