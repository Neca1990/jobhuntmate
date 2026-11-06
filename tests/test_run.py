import re
from datetime import datetime, timezone

import pytest

from conftest import MemoryStore
from engine import channels, run as engine_run
from engine.brand import ROOT, name
from engine.models import Job

NOW = datetime(2026, 11, 5, 10, 0, tzinfo=timezone.utc)  # 11:00 in Belgrade and Berlin


def job(title, location, regions=None, remote=True, url=None):
    slug = re.sub(r"\W+", "-", title + location)
    return Job(source="fake", url=url or f"https://jobs.example/{slug}", title=title,
               company="Acme " + location, location=location, regions=regions or [], remote=remote, posted_at=NOW,
               description_text=f"{title}. Manual and automation testing with Selenium.")


POSTINGS = [
    job("Senior QA Engineer", "Remote - Europe", ["Europe"]),
    job("QA Automation Engineer", "Beograd (hibrid)", ["Beograd"], remote=False),
    job("QA Engineer", "Remote - United States", ["United States"]),
    job("Senior Backend Developer", "Remote - Europe", ["Europe"]),
]


@pytest.fixture
def berlin_user(user):
    return {**user, "id": "u2", "name": "Test Two", "language": "en", "country": "DE",
            "channels": {"telegram": {"chat_id": 222}},
            "searches": [{**user["searches"][0], "locations": ["remote", "city:berlin"]}]}


@pytest.fixture
def fake_site(monkeypatch):
    calls = []

    def fetch(src, ctx):
        calls.append(ctx)
        return list(POSTINGS)

    monkeypatch.setattr(engine_run, "shared_config", lambda store=None: shared(fake_sources()))
    monkeypatch.setitem(engine_run.COLLECTORS, "fake", type("M", (), {"fetch": staticmethod(fetch)}))
    monkeypatch.setitem(engine_run.COLLECTORS, "rsonly", type("M", (), {"fetch": staticmethod(fetch)}))
    monkeypatch.setattr(engine_run.employer, "check", lambda *a: {"status": "unknown"})
    monkeypatch.setattr(engine_run, "summarize", lambda job, w, l, lang, country, known: ("", "none"))
    monkeypatch.setattr(engine_run.time, "sleep", lambda s: None)
    return calls


def fake_sources():
    return {"sources": [{"id": "fake", "name": "Fake board", "min_interval_hours": 2},
                        {"id": "rsonly", "name": "Serbian board", "min_interval_hours": 2, "countries": ["RS"]}]}


def shared(sources):
    """The real taxonomy and language list, with fake sites and no company boards."""
    from engine import store
    return {"taxonomy": store.load_json(store.CONFIG / "taxonomy.json", {}), "sources": sources,
            "languages": store.load_json(store.CONFIG / "languages.json", {"languages": []})["languages"],
            "companies": {"companies": []}}


class FakeChannel:
    def __init__(self):
        self.cards, self.notes = [], []

    def available(self, user):
        return True

    def send_card(self, user, card):
        self.cards.append((user["id"], card))
        return {"n": len(self.cards)}

    def notify(self, user, text):
        self.notes.append((user["id"], text))

    def mark(self, user, ref, label):
        pass


def titles(store, uid):
    return sorted(a["title"] for a in store.files[(uid, "applications")])


def test_each_site_is_asked_once_and_each_user_gets_their_own_matches(user, berlin_user, fake_site, monkeypatch):
    tg = FakeChannel()
    monkeypatch.setitem(channels.CHANNELS, "telegram", tg)
    store = MemoryStore([user, berlin_user])
    engine_run.run(store, now=NOW)
    # the shared board once for both users, the Serbian board once for the Serbian user only
    assert len(fake_site) == 2 and fake_site[1]["countries"] == ["Serbia"]
    assert sorted(fake_site[0]["countries"]) == ["Germany", "Serbia"]
    # Serbia: remote-Europe and the Belgrade office; Berlin: only remote-Europe; nobody: US-only or developer jobs
    assert titles(store, "u1") == ["QA Automation Engineer", "Senior QA Engineer"]
    assert titles(store, "u2") == ["Senior QA Engineer"]
    # each in their own language, buttons carry the posting id
    sent = {uid: card for uid, card in tg.cards}
    assert "Ocena poklapanja" in sent["u1"].html and "Match:" in sent["u2"].html
    assert sent["u2"].actions == [("approve", "✅ Approve"), ("skip", "❌ Skip")]
    assert store.run["state"] == "done" and store.run["sent"] == 3 and store.run["users"] == 2
    assert len(store.added) == 3  # each posting reached the site as soon as its message went out
    app = store.files[("u2", "applications")][0]
    assert app["status"] == engine_run.PENDING and app["refs"] == {"telegram": {"n": len(tg.cards)}}


def test_a_seen_posting_is_not_sent_twice(user, fake_site, monkeypatch):
    tg = FakeChannel()
    monkeypatch.setitem(channels.CHANNELS, "telegram", tg)
    store = MemoryStore([user])
    engine_run.run(store, now=NOW)
    first = len(tg.cards)
    engine_run.run(store, now=NOW.replace(hour=13))  # sites are due again two hours later
    assert first == 2 and len(tg.cards) == 2


def test_outside_active_hours_nothing_is_fetched_unless_forced(user, fake_site, monkeypatch):
    monkeypatch.setitem(channels.CHANNELS, "telegram", FakeChannel())
    night = NOW.replace(hour=1)  # 02:00 in Belgrade
    quiet = MemoryStore([user])
    engine_run.run(quiet, now=night)
    assert fake_site == [] and not hasattr(quiet, "run")  # nothing fetched, nothing reported
    engine_run.run(MemoryStore([user]), now=night, force=True)
    assert len(fake_site) == 2


def test_dry_run_saves_nothing(user, fake_site, monkeypatch):
    monkeypatch.setitem(channels.CHANNELS, "telegram", FakeChannel())
    store = MemoryStore([user])
    engine_run.run(store, now=NOW, dry_run=True)
    assert store.files == {} and store.glob == {}


def test_a_user_without_channels_still_gets_postings_on_the_dashboard(user, fake_site, monkeypatch):
    monkeypatch.setitem(channels.CHANNELS, "telegram", type("Off", (FakeChannel,), {"available": lambda s, u: False})())
    store = MemoryStore([{**user, "channels": {}}])
    engine_run.run(store, now=NOW)
    assert len(store.files[("u1", "applications")]) == 2
    assert all(a["refs"] == {} for a in store.files[("u1", "applications")])


def test_the_name_is_written_only_in_brand_json():
    """Renaming the product must be a one-file change."""
    offenders = [str(p.relative_to(ROOT)) for p in list((ROOT / "engine").rglob("*.py")) + list((ROOT / "site").glob("*.html"))
                 if name().lower() in p.read_text().lower()]
    assert offenders == []


def test_users_in_different_fields_get_different_postings(user, fake_site, monkeypatch):
    monkeypatch.setitem(channels.CHANNELS, "telegram", FakeChannel())
    backend = {**user, "id": "u3", "searches": [{"id": "be", "name": "Backend", "family": "backend", "specializations": [],
                                                  "seniority": ["senior"], "employment_types": [], "locations": ["remote"]}]}
    store = MemoryStore([user, backend])
    engine_run.run(store, now=NOW)
    assert titles(store, "u3") == ["Senior Backend Developer"]
    assert "Senior Backend Developer" not in titles(store, "u1")


def test_a_typed_place_brings_jobs_from_that_town(user, fake_site, monkeypatch):
    monkeypatch.setitem(channels.CHANNELS, "telegram", FakeChannel())
    POSTINGS.append(job("QA Tester", "Sombor (hibrid)", ["Sombor"], remote=False))
    POSTINGS.append(job("Manual QA Engineer", "Šabac", ["Šabac"], remote=False))
    try:
        town = {**user, "searches": [{**user["searches"][0], "locations": ["place:Sombor", "place:Sabac"]}]}
        store = MemoryStore([town])
        engine_run.run(store, now=NOW)
        assert titles(store, "u1") == ["Manual QA Engineer", "QA Tester"]  # written with or without diacritics
    finally:
        del POSTINGS[-2:]


def test_the_public_github_log_never_names_a_site(user, fake_site, monkeypatch, capsys):
    monkeypatch.setitem(channels.CHANNELS, "telegram", FakeChannel())
    monkeypatch.setenv("GITHUB_ACTIONS", "true")
    engine_run.run(MemoryStore([user]), now=NOW)
    log = capsys.readouterr().out
    assert "[site 1] fetched" in log
    assert "fake" not in log.lower() and "rsonly" not in log.lower() and "board" not in log.lower()
