#!/bin/sh
# Saves the Telegram bot token on this Mac after creating the bot in @BotFather.
# Copy the token (Cmd+C), then run:  sh tools/save-bot-token.sh
# The token is read from the clipboard, so it never has to be pasted into a chat.
set -e
cd "$(dirname "$0")/.."
# the token alone or the whole BotFather message both work: the token is picked out of the text
TOKEN=$(pbpaste | grep -oE '[0-9]{6,12}:[A-Za-z0-9_-]{30,}' | head -1)
if [ -z "$TOKEN" ]; then
  echo "U clipboardu nije token (oblik 123456789:AAH...). Clipboard trenutno ima $(pbpaste | wc -c | tr -d ' ') znakova."
  echo "Na Mac-u u Telegramu, u poruci od BotFather-a klikni na token (sam se kopira) ili ga označi i Cmd+C, pa pokreni ponovo."
  exit 1
fi
BOT=$(curl -s "https://api.telegram.org/bot$TOKEN/getMe" | python3 -c "import json,sys; r=json.load(sys.stdin); print(r['result']['username'] if r.get('ok') else '')")
[ -n "$BOT" ] || { echo "Telegram ne prihvata ovaj token. Proveri da si kopirao ceo token novog bota."; exit 1; }
# the bot's username goes into brand.json, the one place the rest of the code reads it from
python3 - "$BOT" <<'PY'
import json, sys
from pathlib import Path
p = Path("config/brand.json")
b = json.loads(p.read_text())
b["bot_username"] = sys.argv[1]
p.write_text(json.dumps(b, ensure_ascii=False, indent=2) + "\n")
PY
umask 077
mkdir -p ~/.jobhuntmate
printf '%s' "$TOKEN" > ~/.jobhuntmate/bot_token
printf '' | pbcopy
echo "Gotovo: token za @$BOT je sačuvan na ovom Mac-u, a ime bota je upisano u config/brand.json (clipboard je obrisan)."
