"""Where users and their data live. The engine only talks to a Store, so the files used now can later be swapped
for the Cloudflare database without touching the search code.

FileStore layout:
  data/users/<id>/user.json          settings: country, language, channels, searches, schedule, profile
  data/users/<id>/state.json         per-user run state
  data/users/<id>/applications.json  postings sent to the user and what became of them
  data/users/<id>/seen.json          postings already handled, for de-duplication
  data/users/<id>/queue.json         matched postings waiting to be sent
  data/global/state.json             shared: when each site was last asked, blocks
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path

from .brand import ROOT
from .http import get_json, post_json

CONFIG = ROOT / "config"
DATA = ROOT / "data"
USER_FILES = {"state": {}, "applications": [], "seen": {}, "queue": []}


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def prune_seen(seen: dict, now: datetime, keep_days: int = 60) -> dict:
    cutoff = (now - timedelta(days=keep_days)).isoformat()
    return {k: v for k, v in seen.items() if v.get("first_seen", "") >= cutoff}


def shared_config(store=None) -> dict:
    """What every user shares: job families, sites, language list, tracked company boards (kept by the store)."""
    return {
        "taxonomy": load_json(CONFIG / "taxonomy.json", {}),
        "sources": load_json(ROOT / "engine" / "plugins" / "sources.json", {"sources": []}),
        "languages": load_json(CONFIG / "languages.json", {"languages": []})["languages"],
        # company job boards found so far live with the users' data (the site's database), not in the repository
        "companies": (store.load_companies() if store else None) or {"max_per_run": 15, "companies": []},
    }


class FileStore:
    def __init__(self, root: Path = DATA):
        self.root = Path(root)

    def users(self) -> list:
        """Active users, each user.json with its id."""
        out = []
        for path in sorted((self.root / "users").glob("*/user.json")):
            user = load_json(path, {})
            if user.get("active", True):
                out.append({**user, "id": path.parent.name})
        return out

    def load(self, user_id: str, name: str):
        return load_json(self.root / "users" / user_id / f"{name}.json", USER_FILES[name])

    def save(self, user_id: str, name: str, data) -> None:
        save_json(self.root / "users" / user_id / f"{name}.json", data)

    def load_global(self) -> dict:
        return load_json(self.root / "global" / "state.json", {})

    def save_global(self, state: dict) -> None:
        save_json(self.root / "global" / "state.json", state)

    def save_posting(self, job_id: str, job: dict) -> None:
        """Full posting text, shared by everyone it was sent to (CV work and re-checks need it)."""
        save_json(self.root / "postings" / f"{job_id}.json", job)

    def load_companies(self):
        return load_json(self.root / "global" / "companies.json", None)

    def load_posting(self, job_id: str):
        return load_json(self.root / "postings" / f"{job_id}.json", None)

    def save_checks(self, user_id: str, checks: list) -> None:
        """Already in the applications saved at the end of the run."""

    def report(self, run: dict) -> None:
        """Where a run stands (the site shows it); nobody to tell locally."""

    def add_application(self, user_id: str, app: dict) -> None:
        """Saved with the rest at the end of the run."""

    def save_sources(self, sources: list) -> None:
        """The site shows the job sites only to signed-in users; locally there is no site."""

    def save_companies(self, companies: dict) -> None:
        save_json(self.root / "global" / "companies.json", companies)


class ApiStore:
    """The site's database, through its engine API (the key is ENGINE_KEY). Used by the hourly search on GitHub,
    so no user data ever lives in the repository."""

    def __init__(self, base_url: str, key: str):
        self.base = base_url.rstrip("/") + "/api/engine"
        self.headers = {"Authorization": f"Bearer {key}"}

    def _get(self, path: str):
        return get_json(f"{self.base}/{path}", timeout=60, headers=self.headers)

    def _put(self, path: str, data) -> None:
        r = post_json(f"{self.base}/{path}", data, timeout=60, headers=self.headers, method="PUT")
        if isinstance(r, dict) and r.get("error"):
            raise RuntimeError(f"site refused {path.split('/')[0]}: {r['error']}")

    def users(self) -> list:
        return self._get("users")["users"]

    def load(self, user_id: str, name: str):
        data = self._get(f"users/{user_id}/{name}")
        return USER_FILES[name] if data is None else data

    def save(self, user_id: str, name: str, data) -> None:
        self._put(f"users/{user_id}/{name}", data)

    def load_global(self) -> dict:
        return self._get("global") or {}

    def save_global(self, state: dict) -> None:
        self._put("global", state)

    def save_posting(self, job_id: str, job: dict) -> None:
        self._put(f"postings/{job_id}", job)

    def load_companies(self):
        return self._get("companies")

    def load_posting(self, job_id: str):
        return self._get(f"postings/{job_id}")

    def save_checks(self, user_id: str, checks: list) -> None:
        """Which waiting postings are still up; the site marks the gone ones and labels their Telegram messages."""
        self._put(f"users/{user_id}/checks", checks)

    def save_sources(self, sources: list) -> None:
        """What signed-in users can pick from (the site has no public list of job sites)."""
        self._put("sources", sources)

    def add_application(self, user_id: str, app: dict) -> None:
        """Right after its message goes out, so a tap on the message finds the posting on the site at once."""
        self._put(f"users/{user_id}/applications", [app])

    def report(self, run: dict) -> None:
        """Where a run stands: the admin page shows a running search and its result."""
        try:
            self._put("run", run)
        except Exception as e:  # a status line must never stop the search
            print(f"run status not saved: {type(e).__name__}")

    def save_companies(self, companies: dict) -> None:
        self._put("companies", companies)
