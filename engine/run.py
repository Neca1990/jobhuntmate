"""One run for everyone: each site is asked once, its postings are matched against every user's searches, and
each user gets their own matches on their own channels.

  python -m engine.run [--force] [--dry-run] [--full] [--check-only]
"""
from __future__ import annotations

import argparse
import os
import time
from collections import Counter
from datetime import datetime, timedelta, timezone

from . import channels, geo, liveness, requirements
from .cards import job_card, short_location
try:  # the job sites and company-site checks live in a private repository, checked out into engine/plugins
    from .plugins import employer
    from .plugins.collectors import COLLECTORS, ats
except ImportError:  # the public code alone (its tests): no sites to visit
    class _NoSites:
        COLLECTORS = {}
        check = staticmethod(lambda *a: {"status": "unknown"})
        expiry = staticmethod(lambda *a: None)
        discover = staticmethod(lambda *a, **k: [])
    employer = ats = _NoSites
    COLLECTORS = {}
from .filters import first_match, location_match
from .http import BlockedError
from .i18n import t
from .models import Job, fuzzy_key
from .schedule import TOLERANCE, effective_interval, in_active_window
from .scoring import score_job
from .store import ApiStore, FileStore, prune_seen, shared_config
from .summarize import summarize
from .textutil import parse_date

EMPLOYER_CHECK_BUDGET = 60  # HTTP calls per run for finding postings on company sites
FULL_SCAN_MAX_AGE = 100000  # "search all postings": no age limit (days)
FULL_SCAN_MIN_GAP = 0.25  # hours since the last visit, for sites without a published limit
# application statuses are codes; every screen shows them in the user's language (i18n "status.<code>")
PENDING, APPROVED, READY, SENT, SKIPPED = "pending", "approved", "ready", "sent", "skipped"


class UserRun:
    """One user's settings and data for this run."""

    def __init__(self, user: dict, store, now: datetime, shared: dict):
        self.user, self.store, self.now = user, store, now
        self.id = user["id"]
        self.lang = user.get("language", "en")
        self.country = user.get("country", "RS")
        self.country_name = geo.country(self.country)["name"]
        self.taxonomy = geo.user_taxonomy(shared["taxonomy"], self.country,
                                          [loc for s in user.get("searches", []) for loc in s.get("locations", [])])
        self.ok_places = geo.ok_places(self.country)
        self.hires_widely = geo.hires_widely(self.country)
        self.state = store.load(self.id, "state")
        self.apps = store.load(self.id, "applications")
        self.seen = prune_seen(store.load(self.id, "seen"), now)
        self.queue = store.load(self.id, "queue")
        self.checks = []  # "is the posting still up" results, saved on their own (the site owns the applications)
        self.fuzzy = {v.get("fuzzy") for v in self.seen.values() if v.get("fuzzy")}
        self.fuzzy |= {fuzzy_key(a.get("company", ""), a.get("title", "")) for a in self.apps}

    @property
    def schedule(self) -> dict:
        return {"timezone": geo.country(self.country)["timezone"], **(self.user.get("schedule") or {})}

    def active(self, force: bool) -> bool:
        return force or in_active_window(self.now, self.schedule)

    def wants(self, src: dict) -> bool:
        if src.get("countries") and self.country not in src["countries"]:
            return False
        return (self.user.get("sources_enabled") or {}).get(src["id"], src.get("enabled", True))

    def save(self) -> None:
        for name, data in (("state", self.state), ("applications", self.apps), ("seen", self.seen), ("queue", self.queue)):
            self.store.save(self.id, name, data)


def search_terms(users: list, taxonomy: dict) -> list:
    terms = []
    for u in users:
        for s in u.user.get("searches", []):
            fam = next((f for f in taxonomy["families"] if f["id"] == s["family"]), None)
            for spec in (fam or {}).get("specializations", []):
                if not s.get("specializations") or spec["id"] in s["specializations"]:
                    terms += [t_ for t_ in spec.get("search_terms", []) if t_ not in terms]
    return terms


def families(users: list) -> set:
    return {s["family"] for u in users for s in u.user.get("searches", [])}


def source_due(src: dict, users: list, last: datetime, now: datetime, force: bool, full: bool) -> bool:
    """A site is asked when the most eager of the users who want it is due, never more often than the site allows."""
    site_min = src.get("hard_min_hours", FULL_SCAN_MIN_GAP) if full else src.get("min_interval_hours", 2)
    if last is None:
        return True
    hours = site_min if (force or full) else effective_interval(
        min(u.schedule.get("interval_hours", 2) for u in users), site_min)
    return now - last >= timedelta(hours=hours) - TOLERANCE


def collect(runs: list, shared: dict, gstate: dict, now: datetime, force=False, full=False) -> Counter:
    """Fetches each due site once and queues its matches for every user who wants that site."""
    stats = Counter()
    taxonomy, companies = shared["taxonomy"], shared["companies"]
    last_fetch = gstate.setdefault("source_last_fetch", {})
    # company boards go last so boards discovered in this run's postings are polled right away
    for src in sorted(shared["sources"]["sources"], key=lambda s: s["id"] == "ats"):
        sid = src["id"]
        wanting = [r for r in runs if r.wants(src)]
        if not wanting or sid not in COLLECTORS:
            continue
        if not source_due(src, wanting, parse_date(last_fetch.get(sid)), now, force, full):
            stats[f"{sid}:not_due"] += 1
            continue
        deep = full or sid not in last_fetch  # a site's first visit goes through all its postings
        ctx = {"terms": search_terms(wanting, taxonomy), "companies": companies, "state": gstate, "now": now,
               "max_age_days": max(r.user.get("max_age_days", 3) for r in wanting), "full": deep,
               "families": families(wanting),
               "board_query": " ".join(dict.fromkeys(f.get("board_query") or f["name"] for f in taxonomy["families"]
                                                     if f["id"] in families(wanting))),
               "site_terms": {f["id"]: f.get("site_terms") or [f["id"]] for f in taxonomy["families"]
                              if f["id"] in families(wanting)},
               "countries": sorted({r.country_name for r in wanting})}
        try:
            jobs = COLLECTORS[sid].fetch(src, ctx)
        except BlockedError as e:
            last_fetch[sid] = now.isoformat()  # a block still counts as a visit: wait the full interval
            gstate.setdefault("blocked", {})[sid] = {"at": now.isoformat(), "message": str(e)}
            stats[f"{sid}:blocked"] += 1
            continue
        except Exception as e:  # one broken site must not stop the others
            print(f"[{sid}] error: {type(e).__name__}")
            stats[f"{sid}:error"] += 1
            continue
        last_fetch[sid] = now.isoformat()
        stats[f"{sid}:fetched"] += len(jobs)
        stats["ats:discovered"] += len(ats.discover(jobs, companies, now))
        max_age = FULL_SCAN_MAX_AGE if deep else src.get("max_age_days")
        for run in wanting:
            for job in jobs:
                stats[f"{sid}:{queue_for(run, job, sid, max_age, shared)}"] += 1
        # counts only: the public log must not show what anyone searches for
        print(f"[{sid}] fetched {stats[f'{sid}:fetched']}, users {len(wanting)}, new {stats[f'{sid}:new']}")
    return stats


def queue_for(run: UserRun, job: Job, sid: str, max_age, shared: dict) -> str:
    """Matches one posting against one user; returns what happened (new, duplicate, dealbreaker, no_match)."""
    m = first_match(job, run.user, run.taxonomy, run.now, max_age)
    if not m:
        return "no_match"
    fk = fuzzy_key(job.company, job.title)
    if job.id in run.seen or fk in run.fuzzy:
        return "duplicate"
    run.fuzzy.add(fk)
    run.seen[job.id] = {"first_seen": run.now.isoformat(), "fuzzy": fk, "status": "queued", "source": sid}
    drop, warn = requirements.evaluate(job, run.user.get("profile") or {}, shared["languages"],
                                       run.user.get("dealbreakers") or {}, run.ok_places)
    if drop:
        run.seen[job.id]["status"] = "dropped: " + "; ".join(r.label(lang_labels(shared["languages"]), run.lang)
                                                             for r in drop)
        return "dealbreaker"
    run.queue.append({"job": job.to_dict(), "match": m.__dict__, "warnings": [w.__dict__ for w in warn],
                      "max_age_days": max_age or run.user.get("max_age_days", 3)})
    return "new"


def lang_labels(languages: list) -> dict:
    return {l["name"]: l.get("label", l["name"]) for l in languages or []}


def cap_score(skills: dict, warnings: list, labels: dict, lang: str) -> dict:
    """A required language the user doesn't speak makes skills secondary (only reached when the user chose "warn")."""
    langs = [w for w in warnings if w.kind == "language" and w.mandatory]
    if langs and skills["score"] > 3:
        skills["score"] = 3
        skills["cap_reason"] = "; ".join(w.label(labels, lang) for w in langs)
    return skills


def allowed_on_company_site(job: Job, check: dict, location_id: str, taxonomy: dict, hires_widely) -> bool:
    """The company's own posting has the final say on where the job can be done from: aggregators sometimes
    list places the employer doesn't. Nothing said there (or just "Remote") keeps the posting.
    taxonomy and hires_widely are the user's (geo.user_taxonomy, geo.hires_widely)."""
    places = (check or {}).get("places", "")
    if not places:
        return True
    probe = Job(source=job.source, url=job.url, title=job.title, company=job.company, location=places, remote=True)
    wanted = [location_id] if location_id and location_id != "unknown" else ["remote"]
    if location_match(probe, wanted, taxonomy) is not None:
        return True
    # the listed places can be just the company's offices while the text says it hires across the region
    return bool(hires_widely.search(job.description_text or ""))


class Shared:
    """Work done once per posting per run, whoever it goes to."""

    def __init__(self):
        self.checks, self.summaries, self.budget = {}, {}, [EMPLOYER_CHECK_BUDGET]

    def check(self, job: Job, companies: dict, gstate: dict, now: datetime) -> dict:
        if job.id not in self.checks:
            self.checks[job.id] = employer.check(job, companies, gstate, now, self.budget)
        return self.checks[job.id]

    def summary(self, run: UserRun, job: Job, warnings: list, labels: dict) -> tuple:
        known = ", ".join(labels.get(l["name"], l["name"]) for l in (run.user.get("profile") or {}).get("languages", []))
        key = (job.id, run.lang, run.country, tuple(w.value for w in warnings))
        if key not in self.summaries:
            self.summaries[key] = summarize(job, warnings, labels, run.lang, run.country_name, known or "English")
        return self.summaries[key]


def send_queue(run: UserRun, shared: dict, gstate: dict, cache: Shared, dry_run: bool) -> int:
    now = run.now
    run.queue[:] = [q for q in run.queue
                    if not q["job"].get("posted_at")
                    or (now - parse_date(q["job"]["posted_at"])).total_seconds() <= q.get("max_age_days", 3) * 86400]
    run.queue.sort(key=lambda q: q["job"].get("posted_at") or "", reverse=True)
    names = {s["id"]: s["name"] for s in shared["sources"]["sources"]}
    labels = lang_labels(shared["languages"])
    targets = channels.for_user(run.user)
    sent = 0
    for item in list(run.queue):
        if sent >= run.user.get("max_messages_per_run", 8):
            break
        job = Job.from_dict(item["job"])
        family = next(f for f in run.taxonomy["families"] if f["id"] == item["match"]["family"])
        warnings = [requirements.Requirement(**w) for w in item.get("warnings", [])]
        skills = cap_score(score_job(job, family, run.user.get("profile") or {}).__dict__, warnings, labels, run.lang)
        check = cache.check(job, shared["companies"], gstate, now)
        if not allowed_on_company_site(job, check, item["match"].get("location_ok"), run.taxonomy, run.hires_widely):
            run.seen.setdefault(job.id, {})["status"] = "dropped: company site excludes the user's country"
            run.queue.remove(item)
            continue
        summary, provider = cache.summary(run, job, warnings, labels)
        expiry = employer.expiry(job, now)
        source = names.get(job.source, job.source)
        card = job_card(item["job"], item["match"], skills, summary, run.taxonomy, source, run.lang, run.country_name,
                        check=check, expiry=expiry, now=now)
        refs = {}
        if dry_run:
            # on GitHub the log is public: the message itself is shown only on a local dry run
            print("---- (dry run) ----" + ("" if os.environ.get("GITHUB_ACTIONS") else f"\n{card.html}"))
        else:
            for name, channel in targets:
                try:
                    refs[name] = channel.send_card(run.user, card)
                except Exception as e:
                    print(f"  {name} failed ({type(e).__name__}); stays queued")
            if targets and not refs:
                break  # every channel failed: keep the rest for the next run
        run.apps.append({
            "id": job.id, "created_at": now.isoformat(), "applied_on": "", "company": job.company, "title": job.title,
            "source": source, "source_id": job.source, "url": job.url,
            "employment_type": item["match"].get("employment_type") or job.employment_type,
            "location": short_location(item["job"], run.lang, run.country_name),
            "seniority": item["match"].get("seniority", ""), "score": skills["score"], "status": PENDING,
            "warnings": [w.label(labels, run.lang) for w in warnings], "summary_by": provider, "notes": [],
            "refs": refs, "company_url": check.get("url", ""),
            "company_check": {"status": check["status"], "board": check.get("board", ""), "at": now.isoformat()},
            "cover_letter": (check.get("form") or {}).get("cover_letter", ""),
            "form_questions": (check.get("form") or {}).get("questions", []),
            "deadline": expiry["date"].date().isoformat() if expiry else "",
            "deadline_source": expiry["source"] if expiry else "", "search_id": item["match"]["search_id"],
        })
        run.seen.setdefault(job.id, {})["status"] = "sent"
        if not dry_run:
            run.store.add_application(run.id, run.apps[-1])
            run.store.save_posting(job.id, item["job"])
        run.queue.remove(item)
        sent += 1
        if not dry_run:
            time.sleep(1.5)  # stay well under the summary providers' and Telegram's rate limits
    if sent and run.queue and not dry_run:
        for name, channel in targets:
            channel.notify(run.user, t(run.lang, "notice.more_waiting", n=len(run.queue)))
    return sent


def check_only(store, shared, now: datetime) -> dict:
    """Just "is it still up" for the postings due a check (right after an approval): no sites searched."""
    runs = [UserRun(u, store, now, shared) for u in store.users()]
    stats = liveness.check(runs, store, shared, COLLECTORS, now)
    print(f"postings checked: {stats['checked']}, gone: {stats['closed']}")
    return stats


def run(store=None, force: bool = False, dry_run: bool = False, now: datetime = None, full: bool = False,
        only_check: bool = False) -> Counter:
    now = now or datetime.now(timezone.utc)
    store = store or FileStore()
    shared = shared_config(store)
    if only_check:
        return Counter(check_only(store, shared, now))
    gstate = store.load_global()
    if not dry_run and shared["sources"]["sources"]:
        store.save_sources([{"id": s["id"], "name": s["name"], "countries": s.get("countries", []),
                             "min_interval_hours": s.get("min_interval_hours", 2), "default": s.get("enabled", True)}
                            for s in shared["sources"]["sources"]])
    runs = [UserRun(u, store, now, shared) for u in store.users()]
    active = [r for r in runs if r.active(force or full)]
    print(f"users: {len(runs)}, in their active hours: {len(active)}")
    if not active:  # e.g. the hourly fallback at night: nothing to do, nothing to report
        return Counter()
    if not dry_run:
        store.report({"state": "running", "started_at": now.isoformat(), "users": len(active), "full": full})
    stats = collect(active, shared, gstate, now, force=force, full=full) if active else Counter()
    cache = Shared()
    for r in active:
        stats["sent"] += send_queue(r, shared, gstate, cache, dry_run)
        r.state["last_run"] = now.isoformat()
    if dry_run:  # a rehearsal leaves no trace
        print(f"sent {stats['sent']} (dry run, nothing saved)")
        return stats
    stats.update(liveness.check(runs, store, shared, COLLECTORS, now))
    print(f"postings checked: {stats['checked']}, gone: {stats['closed']}")
    for r in runs:
        r.save()
    gstate["last_run"] = now.isoformat()
    store.save_global(gstate)
    store.save_companies(shared["companies"])
    store.report({"state": "done", "started_at": now.isoformat(), "finished_at": datetime.now(timezone.utc).isoformat(),
                  "users": len(active), "sent": stats["sent"], "full": full,
                  "new": sum(v for k, v in stats.items() if k.endswith(":new"))})
    print(f"sent {stats['sent']}")
    return stats


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--force", action="store_true", help="search now, whatever the schedule says")
    p.add_argument("--dry-run", action="store_true", help="print the messages instead of sending them")
    p.add_argument("--full", action="store_true", help="go through all postings, with no age limit")
    p.add_argument("--check-only", action="store_true", help="only check whether waiting postings are still up")
    a = p.parse_args()
    # on GitHub the users live in the site's database; locally (and in tests) in data/
    api = os.environ.get("SITE_URL") and os.environ.get("ENGINE_KEY")
    run(ApiStore(os.environ["SITE_URL"], os.environ["ENGINE_KEY"]) if api else FileStore(),
        force=a.force or os.environ.get("FORCE_SEARCH") == "true",
        dry_run=a.dry_run or not os.environ.get("TELEGRAM_BOT_TOKEN"), full=a.full or os.environ.get("FULL_SCAN") == "true",
        only_check=a.check_only or os.environ.get("CHECK_ONLY") == "true")
