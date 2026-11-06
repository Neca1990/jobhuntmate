"""Is a posting still up? Postings waiting for the user (pending, approved, CV being made) are checked about once a
day, and right after an approval: a site may take a posting down long before its stated end date, and then its link
only leads to the site's general list. A posting found gone is marked closed_on; the site shows it, and the Telegram
message gets a label.

A site's collector may know best (it can ask the site's own API): still_open(posting, source) -> True / False /
None (can't tell). Otherwise the posting's own page is asked; a page that is gone or sends us to a general list
counts as closed, and anything unclear (a block, an error) as "can't tell", never as closed."""
from __future__ import annotations

import time
from datetime import datetime, timedelta
from typing import Optional
from urllib.parse import urlparse

from .http import fetch_page
from .textutil import parse_date

CHECKED = {"pending", "approved", "ready"}
RECHECK = timedelta(hours=20)
MAX_PER_RUN = 40


def page_open(url: str) -> Optional[bool]:
    if not url:
        return None
    try:
        status, final, _ = fetch_page(url, timeout=20)
    except Exception:
        return None
    if status in (404, 410):
        return False
    if status != 200:
        return None
    asked, landed = urlparse(url).path.rstrip("/"), urlparse(final or url).path.rstrip("/")
    if landed != asked and len(landed) < len(asked) and asked.startswith(landed):
        return False  # sent "up" to the list the posting was in
    return True


def still_open(posting: dict, collectors: dict, sources: dict, now: datetime) -> Optional[bool]:
    ends = parse_date(posting.get("expires_at")) if posting.get("expires_at") else None
    if ends and ends < now:
        return False
    module = collectors.get(posting.get("source", ""))
    ask = getattr(module, "still_open", None)
    if ask:
        try:
            answer = ask(posting, sources.get(posting.get("source", ""), {}))
        except Exception as e:
            print(f"  posting check failed ({type(e).__name__})")
            answer = None
        if answer is not None:
            return answer
    return page_open(posting.get("url", ""))


def due(app: dict, now: datetime) -> bool:
    if app.get("status") not in CHECKED or app.get("closed_on"):
        return False
    checked = app.get("open_checked_at")
    if not checked:
        return True
    if app.get("decided_at") and app["decided_at"] > checked:
        return True  # approved since the last check
    return now - datetime.fromisoformat(checked) >= RECHECK


def check(runs: list, store, shared: dict, collectors: dict, now: datetime, limit: int = MAX_PER_RUN) -> dict:
    """Checks the postings that are due, for every user; returns counts. A posting several users have is asked once."""
    sources = {s["id"]: s for s in shared["sources"]["sources"]}
    answers, stats = {}, {"checked": 0, "closed": 0}
    # just-approved postings first, then the ones not checked for longest
    todo = sorted(((r, a) for r in runs for a in r.apps if due(a, now)),
                  key=lambda ra: (ra[1].get("status") != "approved", ra[1].get("open_checked_at") or ""))
    for r, app in todo:
        if app["id"] not in answers:
            if len(answers) >= limit:
                break
            posting = store.load_posting(app["id"]) or {"source": app.get("source_id", ""), "url": app.get("url", "")}
            answers[app["id"]] = still_open(posting, collectors, sources, now)
            time.sleep(1)
        answer = answers[app["id"]]
        update = {"id": app["id"], "open_checked_at": now.isoformat()}
        if answer is False:
            update["closed_on"] = now.date().isoformat()
            stats["closed"] += 1
        app.update(update)
        r.checks.append(update)
        stats["checked"] += 1
    for r in runs:
        if r.checks:
            store.save_checks(r.id, r.checks)
    return stats
