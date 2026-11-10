"""Telegram: one shared bot, each user in their own private chat with it (user["channels"]["telegram"]["chat_id"]).
Clicks arrive at the Cloudflare worker; this module only sends and edits messages."""
from __future__ import annotations

import os
import time

from ..http import post_json

API = "https://api.telegram.org/bot{token}/{method}"


def _token() -> str:
    return os.environ.get("TELEGRAM_BOT_TOKEN", "")


def _call(method: str, body: dict) -> dict:
    r = post_json(API.format(token=_token(), method=method), body, timeout=30)
    if r.get("error_code") == 429:  # too many messages: wait as Telegram asks, once
        time.sleep(min(r.get("parameters", {}).get("retry_after", 30), 60) + 1)
        r = post_json(API.format(token=_token(), method=method), body, timeout=30)
    return r


def _chat(user: dict):
    return ((user.get("channels") or {}).get("telegram") or {}).get("chat_id")


def available(user: dict) -> bool:
    return bool(_token() and _chat(user))


def keyboard(card) -> dict:
    return {"inline_keyboard": [[{"text": label, "callback_data": f"{action}:{card.key}"}
                                 for action, label in card.actions]]}


def send_card(user: dict, card) -> dict:
    r = _call("sendMessage", {"chat_id": _chat(user), "text": card.html, "parse_mode": "HTML",
                              "disable_web_page_preview": True, "reply_markup": keyboard(card)})
    if not r.get("ok"):
        raise RuntimeError(f"sendMessage failed: {r.get('description')}")
    # the text is kept with the application, so the site can send the card again if the person deletes it
    return {"chat_id": _chat(user), "message_id": r["result"]["message_id"], "html": card.html}


def notify(user: dict, text: str) -> None:
    _call("sendMessage", {"chat_id": _chat(user), "text": text, "parse_mode": "HTML"})


def mark(user: dict, ref: dict, label: str) -> None:
    _call("editMessageReplyMarkup", {"chat_id": ref["chat_id"], "message_id": ref["message_id"],
                                     "reply_markup": {"inline_keyboard": [[{"text": label, "callback_data": "noop"}]]}})
