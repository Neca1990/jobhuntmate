"""Compare the skills a posting mentions with the user's profile. Purely local: the CV never leaves the repo."""
from __future__ import annotations

from dataclasses import dataclass, field

from .models import Job
from .textutil import has_keyword

PRIOR_WEIGHT = 2


@dataclass
class SkillMatch:
    have: list = field(default_factory=list)     # strong skills the posting asks for
    basic: list = field(default_factory=list)    # asked for, user knows the basics
    missing: list = field(default_factory=list)  # asked for, not in the profile
    score: int = 5


def score_job(job: Job, family: dict, profile: dict) -> SkillMatch:
    text = f"{job.title}\n{job.description_text}"
    levels = {s["name"]: s.get("level", "strong") for s in profile.get("skills", [])}
    m = SkillMatch()
    for skill in family.get("skills_catalog", []):
        if not has_keyword(text, skill["aliases"]):
            continue
        level = levels.get(skill["name"])
        if level == "strong":
            m.have.append(skill["name"])
        elif level == "basic":
            m.basic.append(skill["name"])
        else:
            m.missing.append(skill["name"])
    asked = len(m.have) + len(m.basic) + len(m.missing)
    if asked:
        ratio = (len(m.have) + 0.5 * len(m.basic)) / asked
        # few mentioned skills say little: pull the score toward a neutral 5
        m.score = max(1, min(10, round((10 * ratio * asked + 5 * PRIOR_WEIGHT) / (asked + PRIOR_WEIGHT))))
    return m
