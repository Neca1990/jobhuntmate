#!/bin/sh
# One-time: gives the site its secrets and points the Telegram bot at the site. Safe to run again.
#   sh tools/setup-secrets.sh
# Needs ~/.jobhuntmate/bot_token (tools/save-bot-token.sh) and your Telegram id in ~/.qa_new_jobs_bot_user_id.
set -e
cd "$(dirname "$0")/.."
W="npx --yes wrangler@4.156.2"
PROJECT=$(python3 -c "import json; print(json.load(open('config/brand.json'))['pages_project'])")
SITE=$(python3 -c "import json; print(json.load(open('config/brand.json'))['site_url'])")
umask 077
mkdir -p ~/.jobhuntmate
[ -f ~/.jobhuntmate/bot_token ] || { echo "Prvo: sh tools/save-bot-token.sh"; exit 1; }
[ -f ~/.jobhuntmate/webhook_secret ] || openssl rand -hex 32 > ~/.jobhuntmate/webhook_secret
[ -f ~/.jobhuntmate/engine_key ] || openssl rand -hex 32 > ~/.jobhuntmate/engine_key
[ -f ~/.jobhuntmate/owner_telegram_id ] || cp ~/.qa_new_jobs_bot_user_id ~/.jobhuntmate/owner_telegram_id

echo "Upisujem tajne podatke u Cloudflare…"
for pair in TELEGRAM_BOT_TOKEN:bot_token TELEGRAM_WEBHOOK_SECRET:webhook_secret ENGINE_KEY:engine_key OWNER_TELEGRAM_ID:owner_telegram_id; do
  tr -d '\n' < ~/.jobhuntmate/${pair#*:} | $W pages secret put ${pair%%:*} --project-name "$PROJECT" >/dev/null
done

echo "Objavljujem sajt da bi tajne počele da važe…"
sh tools/deploy-site.sh >/dev/null 2>&1

echo "Povezujem bota sa sajtom…"
python3 - "$SITE" <<'PY'
import json, sys, urllib.request
from pathlib import Path
d = Path("~/.jobhuntmate").expanduser()
token, secret = (d / "bot_token").read_text().strip(), (d / "webhook_secret").read_text().strip()
body = json.dumps({"url": sys.argv[1].rstrip("/") + "/api/telegram", "secret_token": secret,
                   "allowed_updates": ["message", "callback_query"]}).encode()
req = urllib.request.Request(f"https://api.telegram.org/bot{token}/setWebhook", body, {"content-type": "application/json"})
r = json.loads(urllib.request.urlopen(req).read())
print("Telegram:", r.get("description"))
sys.exit(0 if r.get("ok") else 1)
PY
echo "Gotovo. Otvori $SITE i prijavi se preko Telegrama."
