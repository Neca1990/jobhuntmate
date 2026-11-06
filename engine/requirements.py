"""Hard requirements that can make a posting impossible for the user regardless of skills: a spoken language
they don't have, residency/citizenship that excludes the user's country, security clearance. Also pulls out salary.
Everything is pattern based and local; config.json "dealbreakers" decides drop vs. warn per kind."""
from __future__ import annotations

import re
from dataclasses import dataclass

from .i18n import t

LEVEL_RANK = {"basic": 1, "understood": 2, "intermediate": 2, "advanced": 3, "native": 4}

_REQUIRED = r"(?:native|fluent|fluency|mandatory|must[- ]have|a must|required|requirement|essential|proficient|proficiency|" \
            r"business[- ]level|professional|full professional|c1|c2|b2|excellent|strong|very good|perfect)"
_NICE = re.compile(r"\b(nice[- ]to[- ]have|is a plus|a plus|bonus|advantage|advantageous|preferred|preferable|desirable|"
                   r"beneficial|would be great|not required|optional)\b", re.I)


@dataclass
class Requirement:
    kind: str          # language | residency | citizenship | clearance
    value: str         # e.g. "Ukrainian", "US citizen"
    mandatory: bool
    quote: str         # the sentence from the ad, for the message

    def label(self, languages_catalog: dict = None, lang: str = "en") -> str:
        if self.kind == "language":
            name = (languages_catalog or {}).get(self.value, self.value)
            return t(lang, "req.language", name=name) + ("" if self.mandatory else t(lang, "req.nice"))
        return f"{t(lang, 'req.' + self.kind)}: {self.value}"


def _sentences(text: str) -> list:
    parts = re.split(r"(?<=[.!?])\s+|\n+|\s+[|🔹•·]\s+", text or "")
    return [p.strip() for p in parts if p.strip()]


def _lang_patterns(catalog: list) -> list:
    out = []
    for lang in catalog:
        alias = "|".join(re.escape(a) for a in sorted(lang["aliases"], key=len, reverse=True))
        L = rf"(?<![a-z])(?:{alias})(?![a-z])"
        pats = [
            rf"{L}\s*(?:language\s*)?(?:[—–:\-(]|is|as)\s*(?:a\s+|the\s+)?{_REQUIRED}",
            rf"{_REQUIRED}\s+(?:command\s+of\s+|knowledge\s+of\s+|level\s+of\s+|written\s+and\s+spoken\s+|spoken\s+and\s+written\s+|in\s+)*{L}",
            rf"{L}[- ](?:speaking|speaker|speakers)(?!\s+(?:market|countr|customer|client|region|audience|user|team member|colleague))",
            rf"{L}\s+(?:language\s+)?(?:skills\s+)?(?:is|are|would be)\s+(?:a\s+|an\s+)?(?:big\s+|strong\s+)?(?:plus|bonus|advantage|nice to have)",
            rf"(?:speak|speaks|speaking|communicate in|write in|knowledge of|command of)\s+(?:fluent\s+)?{L}",
            rf"{L}\s+(?:language\s+)?(?:skills\s+)?(?:is|are)\s+(?:a\s+)?(?:must|mandatory|required|essential)",
        ]
        out.append((lang["name"], re.compile("|".join(f"(?:{p})" for p in pats), re.I)))
    return out


_CITIZEN = re.compile(r"\b(us|u\.s\.|american|eu|european union|uk|british|ukrainian|canadian|australian|israeli|german|"
                      r"polish|french)\s+(?:citizen|citizenship|national|passport)s?\b|"
                      r"\bcitizenship\s+(?:of|in)\s+(?:the\s+)?([a-z .]+?)(?:\s+(?:is\s+)?required|[,.;]|$)", re.I)
_CLEARANCE = re.compile(r"\b(security clearance|secret clearance|top secret|ts/sci|sc clearance|dv clearance|nv1|nv2|"
                        r"baseline clearance|public trust|clearance required|active clearance|eligible for (?:a )?clearance)\b", re.I)
_RESIDENCY = re.compile(
    r"\b(?:must|should|need to|required to|have to)\s+(?:be\s+)?(?:currently\s+)?(?:based|located|residing|reside|live|living)\s+in\s+(?:the\s+)?([a-z][a-z ,./&-]{1,60})|"
    r"\b(?:only\s+)?(?:candidates|applicants|people|those)\s+(?:who\s+are\s+)?(?:based|located|residing)\s+in\s+(?:the\s+)?([a-z][a-z ,./&-]{1,60}?)\s+(?:only|can apply|are eligible|will be considered)|"
    r"\b([a-z][a-z .]{1,30}?)\s+(?:residents|based candidates|applicants)\s+only\b|"
    r"\b(?:right|authori[sz]ed|eligible|legally (?:able|allowed))\s+to\s+work\s+in\s+(?:the\s+)?([a-z][a-z .]{1,30}?)(?:\s+(?:is\s+)?(?:required|without)|[,.;]|$)",
    re.I)
def detect(text: str, profile: dict, catalog: list, ok_places: re.Pattern) -> list:
    """Requirements the user does NOT meet (known languages and places the user is inside of are skipped).
    ok_places: geo.ok_places(user's country)."""
    known = {l["name"]: LEVEL_RANK.get(l.get("level", "advanced"), 3) for l in profile.get("languages", [])}
    patterns = _lang_patterns(catalog)
    found, seen = [], set()
    for sentence in _sentences(text):
        nice = bool(_NICE.search(sentence))
        for name, pat in patterns:
            m = pat.search(sentence)
            if not m:
                continue
            needs_native = bool(re.search(r"native|mother tongue", m.group(0), re.I))
            if name in known and (known[name] >= 3 or (known[name] >= 2 and not needs_native)):
                if not (needs_native and known[name] < 4):
                    continue
                value = f"{name} (native)"
                req = Requirement("language", value, False, sentence[:220])  # native-level ask of a known language: warn only
            else:
                req = Requirement("language", name, not nice, sentence[:220])
            if ("language", req.value) not in seen:
                seen.add(("language", req.value))
                found.append(req)
        for m in _CITIZEN.finditer(sentence):
            what = (m.group(1) or m.group(2) or "").strip()
            if what and ("citizenship", what.lower()) not in seen and not ok_places.search(what):
                seen.add(("citizenship", what.lower()))
                found.append(Requirement("citizenship", what, not nice, sentence[:220]))
        m = _CLEARANCE.search(sentence)
        if m and ("clearance", "") not in seen and not re.search(r"\bno\s+(?:security\s+)?clearance", sentence, re.I):
            seen.add(("clearance", ""))
            found.append(Requirement("clearance", m.group(1), not nice, sentence[:220]))
        for m in _RESIDENCY.finditer(sentence):
            place = next((g for g in m.groups() if g), "").strip(" ,.")
            if place and not ok_places.search(place) and ("residency", place.lower()) not in seen:
                seen.add(("residency", place.lower()))
                found.append(Requirement("residency", place, not nice, sentence[:220]))
    return found


def apply_policy(reqs: list, policy: dict) -> tuple:
    """(drop_reasons, warnings). Only mandatory requirements can drop; policy per kind is "drop" or "warn"."""
    drop, warn = [], []
    for r in reqs:
        (drop if r.mandatory and policy.get(r.kind, "drop") == "drop" else warn).append(r)
    return drop, warn


_SALARY = re.compile(
    r"(?:(?:salary|compensation|pay|rate|plata|budget)\s*[:\-–]?\s*(?:up to|from|between|of)?\s*)?"
    r"(?:[$€£]|usd|eur|gbp|chf|rsd)\s?\d[\d.,]*\s?[kK]?(?:\s?(?:-|–|to)\s?(?:[$€£]|usd|eur|gbp)?\s?\d[\d.,]*\s?[kK]?)?"
    r"(?:\s?(?:/|per|a)\s?(?:month|mo|year|yr|annum|hour|hr|day))?|"
    r"\d[\d.,]*\s?[kK]?\s?(?:-|–|to)\s?\d[\d.,]*\s?[kK]?\s?(?:usd|eur|gbp|chf|rsd|[$€£])(?:\s?(?:/|per)\s?(?:month|year|hour))?",
    re.I)


def find_salary(text: str) -> str:
    """First pay figure, preferring sentences that say salary/compensation; small sums (benefit budgets) are ignored."""
    sentences = _sentences(text)
    labelled = [s for s in sentences if re.search(r"salary|compensation|pay range|plata|base pay|rate", s, re.I)]
    for sentence in labelled + sentences:
        for m in _SALARY.finditer(sentence):
            figures = [float(x.replace(",", "").replace(".", "")) * (1000 if k else 1)
                       for x, k in re.findall(r"(\d[\d.,]*)\s?([kK])?", m.group(0))]
            if figures and max(figures) >= 1000:
                return m.group(0).strip()
    return ""


def key_lines(text: str, limit: int = 12) -> list:
    """Sentences that look like conditions (language, place, pay, contract) so they survive truncation."""
    pat = re.compile(r"language|native|fluent|speaker|salary|compensation|\$|€|£|usd|eur|based in|located in|reside|"
                     r"citizen|clearance|time ?zone|cet|utc|gmt|contract|b2b|freelance|visa|relocat|on-?site|hybrid|remote",
                     re.I)
    return [s for s in _sentences(text) if pat.search(s)][:limit]


def evaluate(job, profile: dict, catalog: list, policy: dict, ok_places: re.Pattern) -> tuple:
    """(drop, warnings) for a posting, looking at title and full text."""
    return apply_policy(detect(f"{job.title}\n{job.description_text}", profile, catalog, ok_places), policy)
