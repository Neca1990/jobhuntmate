import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
FIX = Path(__file__).parent / "fixtures"


@pytest.fixture
def user():
    """A made-up user in Serbia: QA, remote or Belgrade."""
    return {**fixture_json("user_rs.json"), "id": "u1"}


@pytest.fixture
def taxonomy():
    """The shared taxonomy with the test user's places (remote for Serbia, city:belgrade...)."""
    from engine import geo
    return geo.user_taxonomy(json.loads((ROOT / "config/taxonomy.json").read_text()), "RS")


@pytest.fixture
def config(user):
    """The user's own settings: searches, schedule, max age, dealbreakers."""
    return user


@pytest.fixture
def profile(user):
    return user["profile"]


class MemoryStore:
    """Store kept in memory, for tests."""

    def __init__(self, users):
        self._users, self.files, self.glob, self.postings = users, {}, {}, {}

    def users(self):
        return [u for u in self._users if u.get("active", True)]

    def load(self, user_id, name):
        from engine.store import USER_FILES
        return json.loads(json.dumps(self.files.get((user_id, name), USER_FILES[name])))

    def save(self, user_id, name, data):
        self.files[(user_id, name)] = data

    def load_global(self):
        return json.loads(json.dumps(self.glob))

    def save_global(self, state):
        self.glob = state

    def save_posting(self, job_id, job):
        self.postings[job_id] = job

    def load_companies(self):
        return None

    def report(self, run):
        self.run = run

    def save_sources(self, sources):
        self.sources = sources

    def add_application(self, user_id, app):
        self.added = getattr(self, "added", []) + [(user_id, app["id"])]

    def save_companies(self, companies):
        pass

    def load_posting(self, job_id):
        return self.postings.get(job_id)

    def save_checks(self, user_id, checks):
        self.checks = getattr(self, "checks", []) + [(user_id, c) for c in checks]


@pytest.fixture
def now():
    return datetime(2026, 11, 2, 12, 0, tzinfo=timezone.utc)


def fixture_bytes(name):
    return (FIX / name).read_bytes()


def fixture_json(name):
    return json.loads((FIX / name).read_text())
