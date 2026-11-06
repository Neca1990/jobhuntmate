"""Email: the posting with links to it and to the dashboard (where it is approved or skipped).
Not wired up yet: it needs the site's own domain and a sending service (phase 4). Until then it reports itself
unavailable, so users who chose email are simply skipped for this channel."""
from __future__ import annotations

import os


def _address(user: dict) -> str:
    return ((user.get("channels") or {}).get("email") or {}).get("address", "")


def available(user: dict) -> bool:
    return bool(os.environ.get("EMAIL_API_KEY") and _address(user))


def send_card(user: dict, card) -> dict:
    raise NotImplementedError("email channel arrives in phase 4")


def notify(user: dict, text: str) -> None:
    raise NotImplementedError("email channel arrives in phase 4")


def mark(user: dict, ref: dict, label: str) -> None:
    """An email can't be changed after sending; nothing to do."""
