from __future__ import annotations

from datetime import datetime, time, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

# GitHub's hourly cron drifts by several minutes; don't skip a slot because of that.
TOLERANCE = timedelta(minutes=15)


def _hm(s: str) -> time:
    h, m = s.split(":")
    return time(int(h), int(m))


def in_active_window(now_utc: datetime, sched: dict) -> bool:
    try:
        zone = ZoneInfo(sched.get("timezone") or "UTC")
    except Exception:  # an unknown zone in someone's settings must not stop the search for everyone
        zone = ZoneInfo("UTC")
    local = now_utc.astimezone(zone).time()
    start, end = _hm(sched.get("active_from", "00:00")), _hm(sched.get("active_to", "23:59"))
    return start <= local <= end if start <= end else (local >= start or local <= end)


def effective_interval(user_hours: float, site_min_hours: float) -> float:
    """A site is never asked more often than its own terms allow, whatever the user picks."""
    return max(float(user_hours), float(site_min_hours))


def source_due(now_utc: datetime, last_fetch: Optional[datetime], sched: dict, site_min_hours: float) -> bool:
    if not in_active_window(now_utc, sched):
        return False
    if last_fetch is None:
        return True
    hours = effective_interval(sched.get("interval_hours", 2), site_min_hours)
    return now_utc - last_fetch >= timedelta(hours=hours) - TOLERANCE
