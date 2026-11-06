from __future__ import annotations

import html
import re
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Iterable, Optional


_MOJIBAKE = re.compile("[\u00c2-\u00f4][\u0080-\u00bf]")


def fix_mojibake(s: str) -> str:
    """UTF-8 text that was read as Latin-1 somewhere upstream ("â\x80\x93" for "–", "Ã©" for "é"): turned back when the
    whole text converts cleanly; anything else is left as it is."""
    if not s or not _MOJIBAKE.search(s):
        return s
    for codec in ("latin-1", "cp1252"):
        try:
            return s.encode(codec).decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            continue
    return s


def html_to_text(s: str) -> str:
    if not s:
        return ""
    s = re.sub(r"(?i)<br\s*/?>|</p>|</li>|</h\d>|</div>", "\n", s)
    s = re.sub(r"(?i)<li[^>]*>", "- ", s)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t\xa0]+", " ", s)
    s = re.sub(r"\n\s*\n+", "\n", s)
    return s.strip()


def _pattern(kw: str) -> str:
    # word boundaries that also work for terms like "c#", "ci/cd", ".net"
    return r"(?<![a-z0-9])" + re.escape(kw.lower()) + r"(?![a-z0-9])"


def find_keywords(text: str, keywords: Iterable[str]) -> list:
    low = (text or "").lower()
    return [kw for kw in keywords if re.search(_pattern(kw), low)]


def fold(text: str) -> str:
    """Lowercase without diacritics, for comparing place names: "Šabac" and "Sabac", "Niš" and "Nis" are the same."""
    import unicodedata
    plain = unicodedata.normalize("NFKD", (text or "").replace("đ", "dj").replace("Đ", "Dj"))
    return "".join(ch for ch in plain if not unicodedata.combining(ch)).lower()


def has_keyword(text: str, keywords: Iterable[str]) -> bool:
    return bool(find_keywords(text, keywords))


def parse_date(value) -> Optional[datetime]:
    if value in (None, ""):
        return None
    try:
        if isinstance(value, (int, float)) or (isinstance(value, str) and value.isdigit()):
            return datetime.fromtimestamp(int(value), tz=timezone.utc)
        v = str(value).strip()
        try:
            dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            dt = parsedate_to_datetime(v)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError, OverflowError):
        return None


def first_sentences(text: str, max_chars: int = 280) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    dot = cut.rfind(". ")
    return (cut[: dot + 1] if dot > 80 else cut.rstrip() + "…")


_MONTHS = {m: i + 1 for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"])}
_MONTHS.update({m[:3]: i for m, i in list(_MONTHS.items())})
_DEADLINE_CUE = re.compile(
    r"(?:application\s+deadline|deadline(?:\s+for\s+applications?)?|closing\s+date|apply\s+(?:by|before|until)|"
    r"applications?\s+(?:close|closes|are\s+open\s+until|accepted\s+until)(?:\s+on)?|open\s+until|rok\s+(?:za\s+)?prijav\w*)"
    r"[\s:–-]*", re.I)
_DATE_FORMS = [
    (re.compile(r"(\d{4})-(\d{1,2})-(\d{1,2})"), lambda m: (int(m[1]), int(m[2]), int(m[3]))),
    (re.compile(r"(\d{1,2})[./](\d{1,2})[./](\d{4})"), lambda m: (int(m[3]), int(m[2]), int(m[1]))),
    (re.compile(r"(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+([a-z]{3,9})\.?,?\s+(\d{4})", re.I),
     lambda m: (int(m[3]), _MONTHS.get(m[2].lower()), int(m[1]))),
    (re.compile(r"([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})", re.I),
     lambda m: (int(m[3]), _MONTHS.get(m[1].lower()), int(m[2]))),
]


def find_deadline(text: str, now: datetime) -> Optional[datetime]:
    """An application deadline stated in the posting ("Apply by 15 November 2026"), if it is still ahead."""
    for cue in _DEADLINE_CUE.finditer(text or ""):
        window = text[cue.end():cue.end() + 40]
        for pattern, parts in _DATE_FORMS:
            m = pattern.match(window.lstrip())
            if not m:
                continue
            y, mo, d = parts(m)
            try:
                date = datetime(y, mo, d, 23, 59, tzinfo=timezone.utc) if mo else None
            except ValueError:
                date = None
            if date and now - timedelta(days=1) <= date <= now + timedelta(days=366):
                return date
    return None
