#!/bin/sh
# One-time: lets the hourly search on GitHub reach the site and Telegram, and starts the scheduler.
# Before running: create a GitHub token (see the steps Claude gave you), copy it (Cmd+C), then:
#   sh tools/setup-search.sh
set -e
cd "$(dirname "$0")/.."
REPO=Neca1990/jobhuntmate
GH_TOKEN_VALUE=$(pbpaste | tr -d '[:space:]')
case "$GH_TOKEN_VALUE" in
  github_pat_*|ghp_*) ;;
  *) echo "U clipboardu nije GitHub token (počinje sa github_pat_). Kopiraj ga i pokreni ponovo."; exit 1 ;;
esac
for f in ~/.jobhuntmate/engine_key ~/.jobhuntmate/bot_token ~/.job_hunter_gemini_key ~/.job_hunter_groq_key; do
  [ -f "$f" ] || { echo "Nedostaje $f"; exit 1; }
done

echo "Upisujem ključeve u GitHub…"
gh secret set ENGINE_KEY -R "$REPO" < ~/.jobhuntmate/engine_key
gh secret set TELEGRAM_BOT_TOKEN -R "$REPO" < ~/.jobhuntmate/bot_token
gh secret set GEMINI_API_KEY -R "$REPO" < ~/.job_hunter_gemini_key
gh secret set GROQ_API_KEY -R "$REPO" < ~/.job_hunter_groq_key

echo "Pokrećem raspored (Cloudflare)…"
cd cron
W="npx --yes wrangler@4.156.2"
$W deploy >/dev/null
tr -d '\n' < ~/.jobhuntmate/engine_key | $W secret put ENGINE_KEY >/dev/null
printf '%s' "$GH_TOKEN_VALUE" | $W secret put GH_TOKEN >/dev/null
printf '' | pbcopy
echo "Gotovo: pretraga se pokreće sama kad je neko u svojim aktivnim satima (clipboard je obrisan)."
