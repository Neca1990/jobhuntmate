"""Where a user gets notified. Each channel is one module with the same four functions, so a new one (web push,
Discord, WhatsApp...) is added here without touching the search code:

  available(user) -> bool                    the user connected this channel and it is configured
  send_card(user, card) -> ref               a posting with its action buttons/links; ref identifies the message
  notify(user, text) -> None                 a short note (more postings waiting, a site blocked us...)
  mark(user, ref, label) -> None             after an action, replace the buttons with what was done
"""
from . import email, telegram

CHANNELS = {"telegram": telegram, "email": email}


def for_user(user: dict) -> list:
    """The user's chosen channels that are ready, in their order of preference."""
    wanted = user.get("notify_via") or ["telegram"]
    return [(name, CHANNELS[name]) for name in wanted if name in CHANNELS and CHANNELS[name].available(user)]
