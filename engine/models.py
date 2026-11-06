from __future__ import annotations

import hashlib
import html
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Optional


@dataclass
class Job:
    source: str
    url: str
    title: str
    company: str
    location: str = ""
    regions: list = field(default_factory=list)
    employment_type: str = ""
    seniority_hint: str = ""
    remote: Optional[bool] = None   # True on remote-only boards; domestic sites will set it per posting
    salary: str = ""                # structured pay when the board provides it
    posted_at: Optional[datetime] = None
    expires_at: Optional[datetime] = None   # when the board itself drops the listing, if it says
    description_text: str = ""
    id: str = ""

    def __post_init__(self):
        # some APIs ship HTML entities in plain fields ("Côte d&#x27;Ivoire")
        self.title, self.company, self.location = (html.unescape(x or "").strip()
                                                   for x in (self.title, self.company, self.location))
        self.regions = [html.unescape(r) for r in self.regions]
        if not self.id:
            self.id = job_key(self.source, self.url or f"{self.company}|{self.title}")

    def to_dict(self) -> dict:
        d = asdict(self)
        d["posted_at"] = self.posted_at.isoformat() if self.posted_at else None
        d["expires_at"] = self.expires_at.isoformat() if self.expires_at else None
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Job":
        d = dict(d)
        for k in ("posted_at", "expires_at"):
            if d.get(k):
                d[k] = datetime.fromisoformat(d[k])
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


def job_key(source: str, ident: str) -> str:
    """Short stable id; also fits Telegram's 64-byte callback_data."""
    return hashlib.sha1(f"{source}|{ident}".encode()).hexdigest()[:12]


_COMPANY_SUFFIXES = r"\b(ab|inc|llc|ltd|limited|gmbh|d\.?o\.?o|corp|corporation|co|bv|sa|srl|plc|oy|as)\b\.?"
_TITLE_NOISE = r"\b(senior|sr|junior|jr|mid|middle|medior|lead|principal|staff|remote|m/f/d|f/m/d|m/w/d|\(.*?\))\b"


def fuzzy_key(company: str, title: str) -> str:
    """Company+title normalized so the same role from two boards collapses to one key."""
    c = re.sub(_COMPANY_SUFFIXES, " ", (company or "").lower())
    t = re.sub(r"\(.*?\)", " ", (title or "").lower())
    t = re.sub(_TITLE_NOISE, " ", t)
    norm = lambda s: re.sub(r"[^a-z0-9]+", "", s)
    return f"{norm(c)}|{norm(t)}"
