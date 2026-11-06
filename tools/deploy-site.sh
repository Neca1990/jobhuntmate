#!/bin/sh
# Publishes the site (site/) and its API (functions/) to Cloudflare Pages.
set -e
cd "$(dirname "$0")/.."
PROJECT=$(python3 -c "import json; print(json.load(open('config/brand.json'))['pages_project'])")
node tools/gen-brand.mjs
node tools/gen-options.mjs
cp config/brand.json site/brand.json
node tools/build-site.mjs
npx --yes wrangler@4.156.2 pages deploy --project-name "$PROJECT" --branch main --commit-dirty=true --force
