"""One run for everyone: each site is asked once, its postings are matched against every user's searches, and
each user gets their own matches on their own channels.

  python -m engine.run [--force] [--dry-run] [--full] [--check-only] [--search-all]
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
from .summarize import HEALTH, summarize
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


def site_label(sid: str, shared: dict) -> str:
    """On GitHub the log is public and the sites are not: there a site is only its number in the private list."""
    if not os.environ.get("GITHUB_ACTIONS"):
        return sid
    ids = [s["id"] for s in shared["sources"]["sources"]]
    return f"site {ids.index(sid) + 1}" if sid in ids else "site ?"


POOL_TEXT_MAX = 20000  # characters of a posting's text kept in the archive


def fetch_context(wanting: list, shared: dict, gstate: dict, now: datetime, deep: bool, terms: list = None) -> dict:
    taxonomy = shared["taxonomy"]
    fams = families(wanting)
    return {"terms": search_terms(wanting, taxonomy) if terms is None else terms, "companies": shared["companies"],
            "state": gstate, "now": now, "max_age_days": max(r.user.get("max_age_days", 3) for r in wanting), "full": deep,
            "families": fams,
            "board_query": " ".join(dict.fromkeys(f.get("board_query") or f["name"] for f in taxonomy["families"]
                                                  if f["id"] in fams)),
            "site_terms": {f["id"]: f.get("site_terms") or [f["id"]] for f in taxonomy["families"] if f["id"] in fams},
            "countries": sorted({r.country_name for r in wanting})}


def collect(runs: list, shared: dict, gstate: dict, now: datetime, force=False, full=False, pool: dict = None) -> Counter:
    """Fetches each due site once and queues its matches for every user who wants that site. Every posting found
    also goes into pool (for the archive), matching or not."""
    stats = Counter()
    pool = {} if pool is None else pool
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
        ctx = fetch_context(wanting, shared, gstate, now, deep)
        try:
            jobs = COLLECTORS[sid].fetch(src, ctx)
        except BlockedError as e:
            last_fetch[sid] = now.isoformat()  # a block still counts as a visit: wait the full interval
            gstate.setdefault("blocked", {})[sid] = {"at": now.isoformat(), "message": str(e)}
            stats[f"{sid}:blocked"] += 1
            continue
        except Exception as e:  # one broken site must not stop the others
            print(f"[{site_label(sid, shared)}] error: {type(e).__name__}")
            stats[f"{sid}:error"] += 1
            continue
        last_fetch[sid] = now.isoformat()
        stats[f"{sid}:fetched"] += len(jobs)
        stats["ats:discovered"] += len(ats.discover(jobs, companies, now))
        for job in jobs:
            d = job.to_dict()
            d["description_text"] = (d.get("description_text") or "")[:POOL_TEXT_MAX]
            pool[job.id] = d
        max_age = FULL_SCAN_MAX_AGE if deep else src.get("max_age_days")
        for run in wanting:
            for job in jobs:
                stats[f"{sid}:{queue_for(run, job, sid, max_age, shared)}"] += 1
        # counts only: the public log must not show what anyone searches for
        print(f"[{site_label(sid, shared)}] fetched {stats[f'{sid}:fetched']}, users {len(wanting)}, new {stats[f'{sid}:new']}")
    return stats


def first_look(newcomers: list, others: list, shared: dict, gstate: dict, now: datetime, pool: dict) -> Counter:
    """Someone new asks for everything before their first search: the archive only has what the sites gave for
    everyone else's searches. Sites asked by search terms (by_terms in the site list) are asked once more, just for
    the terms nobody else searches, so the archive has the newcomer's field too. Nothing is queued here."""
    stats = Counter()
    known = set(search_terms(others, shared["taxonomy"]))
    for src in shared["sources"]["sources"]:
        sid = src["id"]
        wanting = [r for r in newcomers if r.wants(src)]
        terms = [t_ for t_ in search_terms(wanting, shared["taxonomy"]) if t_ not in known]
        if not src.get("by_terms") or sid not in COLLECTORS or not wanting or not terms:
            continue
        try:
            jobs = COLLECTORS[sid].fetch(src, fetch_context(wanting, shared, gstate, now, True, terms))
        except Exception as e:  # BlockedError too: the next regular search tries again
            print(f"[{site_label(sid, shared)}] first look: {type(e).__name__}")
            continue
        for job in jobs:
            d = job.to_dict()
            d["description_text"] = (d.get("description_text") or "")[:POOL_TEXT_MAX]
            pool[job.id] = d
        stats["first_look"] += len(jobs)
        print(f"[{site_label(sid, shared)}] first look: fetched {len(jobs)}")
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


def send_queue(run: UserRun, shared: dict, gstate: dict, cache: Shared, dry_run: bool, limit: int = 0,
               archive_first: bool = False) -> int:
    """Sends the best of the user's queue: new postings by date, then the ones from the archive ("search everything")
    by score – or the archive ones first, right after such a search."""
    now = run.now
    # archive postings are old by nature; they leave the queue when the site took them down, checked before sending
    run.queue[:] = [q for q in run.queue
                    if q.get("archive") or not q["job"].get("posted_at")
                    or (now - parse_date(q["job"]["posted_at"])).total_seconds() <= q.get("max_age_days", 3) * 86400]
    run.queue.sort(key=lambda q: (bool(q.get("archive")) == archive_first, q.get("rank", 0), q["job"].get("posted_at") or ""),
                   reverse=True)
    sources = {s["id"]: s for s in shared["sources"]["sources"]}
    names = {s["id"]: s["name"] for s in shared["sources"]["sources"]}
    labels = lang_labels(shared["languages"])
    targets = channels.for_user(run.user)
    sent = 0
    for item in list(run.queue):
        if sent >= (limit or run.user.get("max_messages_per_run", 8)):
            break
        job = Job.from_dict(item["job"])
        if item.get("archive") and liveness.still_open(item["job"], COLLECTORS, sources, now) is False:
            run.seen.setdefault(job.id, {})["status"] = "gone before sending"
            run.queue.remove(item)
            continue
        family = next(f for f in run.taxonomy["families"] if f["id"] == item["match"]["family"])
        warnings = [requirements.Requirement(**w) for w in item.get("warnings", [])]
        # the score is only capped for a language the person said they don't have (none listed: nothing said)
        listed = bool((run.user.get("profile") or {}).get("languages"))
        skills = cap_score(score_job(job, family, run.user.get("profile") or {}).__dict__, warnings if listed else [], labels, run.lang)
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


def search_everything(run: UserRun, pool: list, shared: dict, days: int) -> dict:
    """Matches the whole archive against one user's settings; new matches join their queue, ranked by score."""
    sources = {s["id"]: s for s in shared["sources"]["sources"]}
    found, outcome, dropped = [], Counter(), Counter()
    # postings left out earlier for a condition (a language, a place...) are looked at again: the person may have
    # changed their settings since; the ones still ruled out are left out again
    retry = [k for k, v in run.seen.items() if str(v.get("status", "")).startswith("dropped:")]
    for k in retry:
        del run.seen[k]
    if retry:
        run.fuzzy = {v.get("fuzzy") for v in run.seen.values() if v.get("fuzzy")}
        run.fuzzy |= {fuzzy_key(a.get("company", ""), a.get("title", "")) for a in run.apps}
    outcome["rechecked"] = len(retry)
    for d in pool:
        src = sources.get(d.get("source"))
        if not src or not run.wants(src):
            outcome["site_off"] += 1
            continue
        job = Job.from_dict(d)
        what = queue_for(run, job, d["source"], FULL_SCAN_MAX_AGE, shared)
        outcome[what] += 1
        if what == "new":
            found.append(run.queue[-1])
        elif what == "dealbreaker":
            dropped[run.seen[job.id]["status"].removeprefix("dropped: ")[:60]] += 1
    families = {f["id"]: f for f in run.taxonomy["families"]}
    for item in found:
        item["archive"] = True
        item["rank"] = score_job(Job.from_dict(item["job"]), families[item["match"]["family"]], run.user.get("profile") or {}).score
    # what the search saw, kept with the result in the site's database (never in the public log): so a surprising
    # "nothing found" can be explained afterwards
    diag = {"archive": len(pool), **dict(outcome), "dropped": dict(dropped.most_common(8)),
            "searches": [{k: s_.get(k) for k in ("family", "specializations", "seniority", "locations")}
                         for s_ in run.user.get("searches", [])],
            "languages": [l.get("name") for l in (run.user.get("profile") or {}).get("languages", [])],
            "country": run.country}
    return {"found": len(found), "days": days, "diag": diag}


def answer_search_all(req: dict, store, shared, gstate, cache, runs: list, now: datetime, dry_run: bool,
                      fresh: dict = None) -> int:
    """The "search everything for me" requests waiting on the site: each gets the best few at once and a note.
    fresh: postings found in this run, in case they aren't in the archive yet (a dry run doesn't write them)."""
    todo = [r for r in runs if r.id in req["users"]]
    if not todo:
        return 0
    pool = list({**{d["id"]: d for d in store.load_pool()}, **(fresh or {})}.values())
    send, days = req.get("send", 15), req.get("days", 45)
    sent_total = 0
    for r in todo:
        if not dry_run:
            store.search_all_update(r.id, "running", {})
        result = search_everything(r, pool, shared, days)
        sent = send_queue(r, shared, gstate, cache, dry_run, limit=send, archive_first=True) if result["found"] else 0
        waiting_now = sum(1 for q in r.queue if q.get("archive"))
        result.update(sent=sent, waiting=waiting_now)
        for name, channel in ([] if dry_run else channels.for_user(r.user)):
            key = "notice.search_all" if result["found"] else "notice.search_all_none"
            channel.notify(r.user, t(r.lang, key, days=days, found=result["found"], sent=sent, waiting=waiting_now))
        if not dry_run:
            store.search_all_update(r.id, "done", result)
        sent_total += sent
    print(f"search everything: {len(todo)} requests, sent {sent_total}")
    return sent_total


def check_only(store, shared, now: datetime) -> dict:
    """Just "is it still up" for the postings due a check (right after an approval): no sites searched."""
    runs = [UserRun(u, store, now, shared) for u in store.users()]
    stats = liveness.check(runs, store, shared, COLLECTORS, now)
    print(f"postings checked: {stats['checked']}, gone: {stats['closed']}")
    return stats


def run(store=None, force: bool = False, dry_run: bool = False, now: datetime = None, full: bool = False,
        only_check: bool = False, only_search_all: bool = False) -> Counter:
    now = now or datetime.now(timezone.utc)
    store = store or FileStore()
    shared = shared_config(store)
    HEALTH.reset()
    if only_check:
        return Counter(check_only(store, shared, now))
    gstate = store.load_global()
    if not dry_run and not only_search_all and shared["sources"]["sources"]:
        store.save_sources([{"id": s["id"], "name": s["name"], "countries": s.get("countries", []),
                             "min_interval_hours": s.get("min_interval_hours", 2), "default": s.get("enabled", True)}
                            for s in shared["sources"]["sources"]])
    runs = [UserRun(u, store, now, shared) for u in store.users()]
    # "search everything" only reads the archive: no sites, whatever the hour
    active = [] if only_search_all else [r for r in runs if r.active(force or full)]
    asked = store.search_all_requests()
    print(f"users: {len(runs)}, in their active hours: {len(active)}, search everything: {len(asked['users'])}")
    if not active and not asked["users"]:  # e.g. the hourly fallback at night: nothing to do, nothing to report
        return Counter()
    if not dry_run and active:
        store.report({"state": "running", "started_at": now.isoformat(), "users": len(active), "full": full})
    pool = {}
    stats = collect(active, shared, gstate, now, force=force, full=full, pool=pool) if active else Counter()
    newcomers = [r for r in runs if r.id in asked["users"] and not r.state.get("last_run")]
    if newcomers:
        stats.update(first_look(newcomers, [r for r in runs if r not in newcomers], shared, gstate, now, pool))
    if pool and not dry_run:
        stats["archive:new"] = store.save_pool(list(pool.values()))
        print(f"archive: {stats['archive:new']} new postings")
    cache = Shared()
    for r in active:
        stats["sent"] += send_queue(r, shared, gstate, cache, dry_run)
        r.state["last_run"] = now.isoformat()
    stats["sent"] += answer_search_all(asked, store, shared, gstate, cache, runs, now, dry_run, fresh=pool)
    if HEALTH.used or HEALTH.failed:
        print(HEALTH.line())
    if dry_run:  # a rehearsal leaves no trace
        print(f"sent {stats['sent']} (dry run, nothing saved)")
        return stats
    stats.update(liveness.check(runs, store, shared, COLLECTORS, now))
    print(f"postings checked: {stats['checked']}, gone: {stats['closed']}")
    for r in runs:
        r.save()
    if active:
        gstate["last_run"] = now.isoformat()
        store.save_global(gstate)
        store.save_companies(shared["companies"])
        kept = store.pool_cleanup() or {}
        if kept:
            print(f"archive: {kept.get('rows')} postings, {kept.get('size_mb')} MB, kept {kept.get('days')} days")
        store.report({"state": "done", "started_at": now.isoformat(), "finished_at": datetime.now(timezone.utc).isoformat(),
                      "users": len(active), "sent": stats["sent"], "full": full, "summaries": HEALTH.report(),
                      "new": sum(v for k, v in stats.items() if k.endswith(":new") and not k.startswith("archive"))})
    print(f"sent {stats['sent']}")
    return stats


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--force", action="store_true", help="search now, whatever the schedule says")
    p.add_argument("--dry-run", action="store_true", help="print the messages instead of sending them")
    p.add_argument("--full", action="store_true", help="go through all postings, with no age limit")
    p.add_argument("--check-only", action="store_true", help="only check whether waiting postings are still up")
    p.add_argument("--search-all", action="store_true", help='only the "search everything" requests, from the archive')
    a = p.parse_args()
    # on GitHub the users live in the site's database; locally (and in tests) in data/
    api = os.environ.get("SITE_URL") and os.environ.get("ENGINE_KEY")
    run(ApiStore(os.environ["SITE_URL"], os.environ["ENGINE_KEY"]) if api else FileStore(),
        force=a.force or os.environ.get("FORCE_SEARCH") == "true",
        dry_run=a.dry_run or not os.environ.get("TELEGRAM_BOT_TOKEN"), full=a.full or os.environ.get("FULL_SCAN") == "true",
        only_check=a.check_only or os.environ.get("CHECK_ONLY") == "true",
        only_search_all=a.search_all or os.environ.get("SEARCH_ALL") == "true")
