from datetime import datetime, timedelta, timezone

from conftest import MemoryStore
from engine import liveness

NOW = datetime(2026, 11, 6, 9, 0, tzinfo=timezone.utc)


class Run:
    def __init__(self, uid, apps):
        self.id, self.apps, self.checks = uid, apps, []


def app(i, status="pending", **kw):
    return {"id": i, "status": status, "url": f"https://jobs.example/{i}", **kw}


def shared():
    return {"sources": {"sources": [{"id": "fake", "url": "https://jobs.example/api"}]}}


def site(answers, calls):
    def still_open(posting, source):
        calls.append(posting["url"])
        return answers.get(posting["url"])
    return {"fake": type("M", (), {"still_open": staticmethod(still_open)})}


def test_gone_postings_are_marked_and_asked_once_for_everyone(monkeypatch):
    monkeypatch.setattr(liveness.time, "sleep", lambda s: None)
    monkeypatch.setattr(liveness, "page_open", lambda url: None)
    store = MemoryStore([])
    store.postings = {"a": {"source": "fake", "url": "https://jobs.example/a"}, "b": {"source": "fake", "url": "https://jobs.example/b"}}
    calls = []
    runs = [Run("u1", [app("a", "approved"), app("b")]), Run("u2", [app("a")])]
    stats = liveness.check(runs, store, shared(), site({"https://jobs.example/a": False, "https://jobs.example/b": True}, calls), NOW)
    assert calls.count("https://jobs.example/a") == 1
    assert stats == {"checked": 3, "closed": 2}
    assert runs[0].apps[0]["closed_on"] == "2026-11-06"
    assert "closed_on" not in runs[0].apps[1]
    assert {(u, c["id"]) for u, c in store.checks} == {("u1", "a"), ("u1", "b"), ("u2", "a")}


def test_what_is_due_for_a_check():
    checked = (NOW - timedelta(hours=2)).isoformat()
    assert liveness.due(app("a"), NOW)
    assert not liveness.due(app("a", open_checked_at=checked), NOW)
    assert liveness.due(app("a", open_checked_at=(NOW - timedelta(hours=21)).isoformat()), NOW)
    assert liveness.due(app("a", "approved", open_checked_at=checked, decided_at=(NOW - timedelta(hours=1)).isoformat()), NOW)
    assert not liveness.due(app("a", "sent"), NOW)
    assert not liveness.due(app("a", closed_on="2026-11-05"), NOW)


def test_unclear_answers_never_close_a_posting(monkeypatch):
    monkeypatch.setattr(liveness, "page_open", lambda url: None)
    assert liveness.still_open({"source": "other", "url": "https://jobs.example/x"}, {}, {}, NOW) is None
    assert liveness.still_open({"source": "other", "expires_at": "2026-11-01T00:00:00+00:00"}, {}, {}, NOW) is False


def test_a_page_that_sends_us_to_the_general_list_is_gone(monkeypatch):
    pages = {"https://jobs.example/jobs/qa-1": (200, "https://jobs.example/jobs", b""),
             "https://jobs.example/jobs/qa-2": (200, "https://jobs.example/jobs/qa-2", b""),
             "https://jobs.example/jobs/qa-3": (404, "https://jobs.example/jobs/qa-3", b""),
             "https://jobs.example/jobs/qa-4": (403, "https://jobs.example/jobs/qa-4", b"")}
    monkeypatch.setattr(liveness, "fetch_page", lambda url, timeout=20: pages[url])
    assert [liveness.page_open(f"https://jobs.example/jobs/qa-{i}") for i in range(1, 5)] == [False, True, False, None]
