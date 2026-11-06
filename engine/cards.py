"""The message about one posting, in the user's language. Channels decide how to show it (Telegram HTML, email)."""
from __future__ import annotations

import html
from dataclasses import dataclass, field

from .i18n import t


@dataclass
class Card:
    key: str                 # the posting's id; actions refer to it
    html: str                # body: simple HTML (b, a) that Telegram and email both render
    url: str                 # the posting
    actions: list = field(default_factory=list)  # [(action, label)], e.g. [("approve", "✅ Approve")]


def _name(items: list, ident: str) -> str:
    return next((x["name"] for x in items if x["id"] == ident), "")


def short_location(job: dict, lang: str, country_name: str) -> str:
    regions = job.get("regions") or []
    if len(regions) > 6:
        mine = any(r.lower() == country_name.lower() for r in regions)
        return t(lang, "card.countries_incl" if mine else "card.countries", n=len(regions), country=country_name)
    return job.get("location") or t(lang, "card.place_unknown")


def _summary_html(summary: str) -> list:
    out = []
    for line in summary.splitlines():
        label, sep, rest = line.partition(":")
        # bold the "Label:" part of the model's structured lines
        out.append(f"<b>{html.escape(label)}:</b>{html.escape(rest)}" if sep and len(label) <= 20 else html.escape(line))
    return out


def employer_lines(check: dict, expiry: dict, source_name: str, now, lang: str) -> list:
    """Where the posting stands on the company's own site, and until when it is open."""
    e = html.escape
    lines = []
    if check:
        board = e((check.get("board") or "").split("/")[0].capitalize())
        src = e(source_name)
        if check["status"] == "active" and check.get("link_broken"):
            lines.append(t(lang, "card.site_active_broken", board=board, source=src))
        elif check["status"] == "active" and check.get("url") and check.get("board"):
            lines.append(t(lang, "card.site_active_checked", board=board))
        elif check["status"] == "active":
            lines.append(t(lang, "card.site_active"))
        elif check["status"] == "missing":
            lines.append(t(lang, "card.site_missing", board=board, others=check.get("others", 0), source=src))
        else:
            lines.append(t(lang, "card.site_none", source=src))
    if check and check.get("places") and check["status"] == "active":
        lines.append(t(lang, "card.places", places=e(check["places"][:200])))
    form = (check or {}).get("form") or {}
    if form:
        value = t(lang, f"card.letter.{form.get('cover_letter') or 'unknown'}")
        lines.append(t(lang, "card.letter", value=value))
        if form.get("questions"):
            lines.append(t(lang, "card.questions", questions=e("; ".join(form["questions"]))[:400]))
    if expiry:
        where = t(lang, "card.expires.text") if expiry["source"] == "text" else t(lang, "card.expires.source",
                                                                                   source=e(source_name))
        lines.append(t(lang, "card.expires", date=expiry["date"].strftime("%d.%m.%Y."),
                       days=(expiry["date"] - now).days, where=where))
    else:
        lines.append(t(lang, "card.no_deadline"))
    return lines


def job_card(job: dict, match: dict, skills: dict, summary: str, taxonomy: dict, source_name: str, lang: str,
             country_name: str, check: dict = None, expiry: dict = None, now=None) -> Card:
    e = html.escape
    location = short_location(job, lang, country_name)
    if match.get("location_ok") == "unknown":
        location += " ⚠️"
    etype = _name(taxonomy["employment_types"], match.get("employment_type", "")) or (
        job.get("employment_type") or t(lang, "card.type_unknown"))
    level = _name(taxonomy["seniority"], match.get("seniority", "")) or t(lang, "card.level_unknown")
    lines = [
        f"🆕 <b>{e(job['title'])}</b> – {e(job.get('company') or '?')} ({e(source_name)})",
        f"📍 {e(location)} · {e(etype)} · {e(level)}",
        t(lang, "card.match", score=skills["score"]) + (f" ({e(skills['cap_reason'])})" if skills.get("cap_reason") else ""),
        "",
    ]
    if summary:
        lines += _summary_html(summary) + [""]
    if skills["have"]:
        lines.append("✅ " + e(", ".join(skills["have"])))
    if skills["basic"]:
        lines.append("⚠️ " + e(", ".join(t(lang, "card.basic", skill=s) for s in skills["basic"])))
    if skills["missing"]:
        lines.append("❌ " + e(", ".join(skills["missing"])))
    if not (skills["have"] or skills["basic"] or skills["missing"]):
        lines.append(t(lang, "card.no_tech"))
    # validity, deadline and links go last and are never cut off by the length limit
    tail = employer_lines(check, expiry, source_name, now, lang) if now else []
    links = [f'🔗 <a href="{e(job["url"], quote=True)}">{t(lang, "card.link", source=e(source_name))}</a>']
    if check and check.get("url") and check["url"] != job["url"]:
        links.append(f'🏢 <a href="{e(check["url"], quote=True)}">{t(lang, "card.company_link")}</a>')
    body = "\n".join(lines)[:3500] + "\n\n" + "\n".join(tail + links)
    return Card(key=job["id"], html=body, url=job["url"],
                actions=[("approve", t(lang, "btn.approve")), ("skip", t(lang, "btn.skip"))])
