"""Places, per user: a remote posting is open to a user when it names their country, one of its regions, or the
whole world; an office posting when it names one of the cities they picked. Everything comes from config/geo.json."""
from __future__ import annotations

import copy
import json
import re
from functools import lru_cache

from .brand import ROOT


@lru_cache(maxsize=1)
def geo() -> dict:
    return json.loads((ROOT / "config" / "geo.json").read_text())


def country(code: str) -> dict:
    found = next((c for c in geo()["countries"] if c["code"] == (code or "").upper()), None)
    if not found:
        raise KeyError(f"unknown country {code!r} (add it to config/geo.json)")
    return found


def remote_keywords(code: str) -> list:
    c = country(code)
    words = list(geo()["worldwide"]) + c["aliases"]
    for region in c["regions"]:
        words += geo()["regions"].get(region, [])
    return list(dict.fromkeys(words))


def locations(code: str) -> list:
    """The user's location choices in the shape filters.location_match expects: "remote" plus "city:<id>"."""
    c = country(code)
    return ([{"id": "remote", "name": "Remote", "mode": "remote", "keywords": remote_keywords(code)}]
            + [{"id": f"city:{x['id']}", "name": x["name"], "mode": "onsite", "keywords": x["aliases"]} for x in c["cities"]])


def place_keywords(name: str) -> list:
    """A place the user typed ("Sombor", "Šabac"); location matching ignores diacritics (textutil.fold)."""
    return [name.strip().lower()] if name.strip() else []


def user_taxonomy(taxonomy: dict, code: str, places: list = ()) -> dict:
    """The shared taxonomy with this user's places filled in: their country's remote reach, its cities, and any
    place they typed themselves ("place:<name>" in a search's locations)."""
    view = copy.copy(taxonomy)
    typed = [p for p in dict.fromkeys(places) if p.startswith("place:") and p[6:].strip()]
    view["locations"] = locations(code) + [{"id": p, "name": p[6:], "mode": "onsite", "keywords": place_keywords(p[6:])}
                                           for p in typed]
    return view


def _alternatives(words: list) -> str:
    return "|".join(re.escape(w) for w in sorted(set(words), key=len, reverse=True))


def ok_places(code: str) -> re.Pattern:
    """Places the user is inside of: a residency or citizenship demand naming one of these doesn't exclude them.
    "EU" counts only for members: a remote job open to the EU time zone is fine, EU citizenship is not."""
    words = remote_keywords(code)
    if not country(code).get("eu_member"):
        words = [w for w in words if w not in geo()["eu_words"]]
    return re.compile(rf"\b({_alternatives(words)})\b", re.I)


def hires_widely(code: str) -> re.Pattern:
    """Posting text saying the company hires across the user's region (its listed places may be just offices)."""
    c = country(code)
    places = list(geo()["worldwide"]) + c["aliases"] + [w for r in c["regions"] for w in geo()["regions"].get(r, [])
                                                        if len(w) > 3]  # skip "eu", "cet": too loose in prose
    return re.compile(r"\b(hiring|hire|recruiting|work|working|based|located|live|living|reside|residing|candidates)"
                      r"\s+(?:\w+\s+){0,2}(?:in|from|within|across)\s+(?:the\s+)?"
                      rf"({_alternatives(places)})\b", re.I)
