from __future__ import annotations

import json
import urllib.error
import urllib.request

from .brand import brand

USER_AGENT = f"{brand()['name']}/0.1 (+{brand()['site_url']})"


class BlockedError(Exception):
    """The site refused us (rate limit, login wall). Skip quietly and try again later."""


def fetch_page(url: str, timeout: int = 30, headers: dict = None) -> tuple:
    """(status, final_url, body) without raising on HTTP errors — for sites that signal blocks via status codes."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.geturl(), r.read()
    except urllib.error.HTTPError as e:
        return e.code, url, b""


def get(url: str, timeout: int = 30, headers: dict = None) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def get_json(url: str, timeout: int = 30, headers: dict = None):
    return json.loads(get(url, timeout, {"Accept": "application/json", **(headers or {})}))


def post_json(url: str, body, timeout: int = 30, headers: dict = None, method: str = "POST"):
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"User-Agent": USER_AGENT, "Content-Type": "application/json", **(headers or {})},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read())
        except ValueError:
            raise e
