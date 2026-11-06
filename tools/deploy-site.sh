#!/bin/sh
# Publishes the site (site/) and its API (functions/) to Cloudflare Pages, then checks that the live site really
# serves the new version (a deploy can fail on Cloudflare's side); tries up to 3 times. Ends with "LIVE <version>"
# or "DEPLOY FAILED" (exit 1).
set -e
cd "$(dirname "$0")/.."
PROJECT=$(python3 -c "import json; print(json.load(open('config/brand.json'))['pages_project'])")
SITE=$(python3 -c "import json; print(json.load(open('config/brand.json'))['site_url'].rstrip('/'))")
node tools/gen-brand.mjs
node tools/gen-options.mjs
cp config/brand.json site/brand.json
node tools/build-site.mjs
VERSION=$(python3 -c "import json; print(json.load(open('build/version.json'))['version'])")
LOG=$(mktemp)

for attempt in 1 2 3; do
  if npx --yes wrangler@4.156.2 pages deploy --project-name "$PROJECT" --branch main --commit-dirty=true --force >"$LOG" 2>&1; then
    for i in 1 2 3 4 5 6; do
      live=$(curl -s "$SITE/version.json?t=$(date +%s)$i" | python3 -c "import json,sys; print(json.load(sys.stdin).get('version',''))" 2>/dev/null || true)
      if [ "$live" = "$VERSION" ]; then
        echo "LIVE $VERSION"
        exit 0
      fi
      sleep 5
    done
    echo "attempt $attempt: deployed, but the site still serves ${live:-?}"
  else
    echo "attempt $attempt: $(grep -m1 -E 'Got error|ERROR' "$LOG" | sed 's/\x1b\[[0-9;]*m//g' | tr -s ' ')"
  fi
  [ "$attempt" -lt 3 ] && sleep 30
done
echo "DEPLOY FAILED – the site still serves an older version"
exit 1
