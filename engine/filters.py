"""Taxonomy-driven filtering. Nothing role-specific lives here: adding a family to
config/taxonomy.json is enough for new positions to be searched and filtered."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Optional

from .models import Job
from .textutil import find_keywords, fold, has_keyword


@dataclass
class Match:
    search_id: str
    family: str
    specializations: list = field(default_factory=list)
    seniority: str = ""          # detected id, "" when the posting doesn't say
    employment_type: str = ""    # detected id, "" when unknown
    location_ok: str = ""        # matched location id, or "unknown"


def _by_id(items: list, ident: str) -> Optional[dict]:
    return next((x for x in items if x["id"] == ident), None)


def detect_seniority(job: Job, taxonomy: dict) -> str:
    text = f"{job.title} {job.seniority_hint}"
    # senior wins over mid when both appear ("Senior / Mid QA"), junior is checked last
    for level in sorted(taxonomy["seniority"], key=lambda s: {"senior": 0, "medior": 1}.get(s["id"], 2)):
        if has_keyword(text, level["keywords"]):
            return level["id"]
    return ""


def detect_employment_type(job: Job, taxonomy: dict) -> str:
    text = job.employment_type
    for t in taxonomy["employment_types"]:
        if has_keyword(text, t["keywords"]):
            return t["id"]
    return ""


def location_match(job: Job, wanted: list, taxonomy: dict) -> Optional[str]:
    """Matched location id, "unknown" for a remote posting that names no region, None to reject.

    mode "remote": the posting is remote and its allowed regions include the user's country (geo.locations).
    mode "onsite": the posting's location names the city (office or hybrid), remote or not.
    """
    text = " ".join([job.location, *job.regions]).strip()
    region_unknown = not text or text.lower() in ("remote", "remote job", "fully remote")
    for loc_id in wanted:
        loc = _by_id(taxonomy["locations"], loc_id)
        if not loc:
            continue
        if loc.get("mode") == "remote":
            if job.remote is False:
                continue
            if has_keyword(fold(text), [fold(k) for k in loc["keywords"]]):
                return loc_id
            if region_unknown and job.remote:
                return "unknown"
        elif has_keyword(fold(text), [fold(k) for k in loc["keywords"]]):
            return loc_id
    # anything else names specific places (e.g. "United States", "Germany") that don't include the user
    return None


def match_search(job: Job, search: dict, taxonomy: dict, now: datetime, max_age_days: int) -> Optional[Match]:
    family = _by_id(taxonomy["families"], search["family"])
    if not family:
        return None
    if job.posted_at and now - job.posted_at > timedelta(days=max_age_days):
        return None
    if not has_keyword(job.title, family["title_keywords"]):
        return None
    if has_keyword(job.title, family.get("title_exclude_keywords", [])):
        return None

    full_text = f"{job.title}\n{job.description_text}"
    if search.get("exclude_keywords") and has_keyword(full_text, search["exclude_keywords"]):
        return None
    if search.get("include_keywords") and not has_keyword(full_text, search["include_keywords"]):
        return None

    wanted_specs = search.get("specializations") or [s["id"] for s in family["specializations"]]
    found_specs = [s["id"] for s in family["specializations"]
                   if s["id"] in wanted_specs and has_keyword(full_text, s["keywords"])]
    all_specs = {s["id"] for s in family["specializations"]}
    if not found_specs and set(wanted_specs) != all_specs:
        return None  # user narrowed the specialization and the posting shows none of it

    seniority = detect_seniority(job, taxonomy)
    if seniority and search.get("seniority") and seniority not in search["seniority"]:
        return None

    etype = detect_employment_type(job, taxonomy)
    if etype and search.get("employment_types") and etype not in search["employment_types"]:
        return None

    loc = location_match(job, search.get("locations") or [], taxonomy)
    if loc is None:
        return None

    return Match(search_id=search["id"], family=family["id"], specializations=found_specs,
                 seniority=seniority, employment_type=etype, location_ok=loc)


def first_match(job: Job, config: dict, taxonomy: dict, now: datetime, max_age_days: int = None) -> Optional[Match]:
    """max_age_days overrides the user's setting for sources whose postings stay open for weeks (company boards)."""
    for search in config["searches"]:
        m = match_search(job, search, taxonomy, now, max_age_days or config.get("max_age_days", 3))
        if m:
            return m
    return None
