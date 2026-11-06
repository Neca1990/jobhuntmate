"""Summary of a posting in the user's language: conditions first, then pay, level, skills, what you'd do.
Only the public posting text is sent to the AI providers. Locally detected conditions and salary are
guaranteed to appear even if the model leaves them out."""
from __future__ import annotations

import os
import re
import urllib.error
from collections import Counter

from .http import post_json
from .i18n import t
from .models import Job
from .requirements import find_salary, key_lines
from .textutil import first_sentences

GEMINI_MODEL = "gemini-3.5-flash-lite"
GROQ_MODEL = "openai/gpt-oss-120b"
CLIP = 12000


def _prompt(job: Job, lang: str, country: str, languages: str) -> str:
    text = f"{job.title} – {job.company}\n{job.description_text}"
    key = "\n".join(f"- {line}" for line in key_lines(text)) or f"- {t(lang, 'sum.none')}"
    return t(lang, "sum.prompt", key=key, text=text[:CLIP], country=country, languages=languages)


def _clean(text: str) -> str:
    lines = []
    for line in (text or "").replace("**", "").splitlines():
        line = re.sub(r"\s+", " ", line).strip(" -•*")
        if line:
            lines.append(line[:300])
    return "\n".join(lines[:8])


class AIError(Exception):
    """A provider answered with an error, blocked the prompt or gave no text. The message is only the provider's
    codes (e.g. "429 RESOURCE_EXHAUSTED", "blocked SAFETY"), never its wording: the search log is public, and error
    texts can carry account details."""

    def __init__(self, reason: str, pause: bool = False):
        super().__init__(reason)
        self.pause = pause  # no point asking again this run (quota used up, key refused)


_CODE = re.compile(r"[A-Za-z0-9_.-]{1,40}")
# answers that won't change within a run: the quota is gone, or the key/model is refused
_PAUSE = {"429", "401", "403", "404", "RESOURCE_EXHAUSTED", "PERMISSION_DENIED", "UNAUTHENTICATED", "NOT_FOUND",
          "rate_limit_exceeded", "insufficient_quota", "invalid_api_key", "model_not_found", "model_decommissioned"}


def _codes(*values) -> list:
    return [str(v) for v in values if v not in (None, "") and _CODE.fullmatch(str(v))]


def _check_error(r) -> None:
    # post_json hands back the error body on HTTP errors instead of raising
    err = r.get("error") if isinstance(r, dict) else None
    if not isinstance(r, dict):
        raise AIError("unexpected answer")
    if err:
        err = err if isinstance(err, dict) else {}
        codes = _codes(err.get("code"), err.get("status"), err.get("type"))
        raise AIError(" ".join(codes) or "error", pause=bool(_PAUSE & set(codes)))


def _gemini(prompt: str) -> str:
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        return ""
    r = post_json(
        f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent",
        {"contents": [{"parts": [{"text": prompt}]}]},
        timeout=30, headers={"x-goog-api-key": key},
    )
    _check_error(r)
    if not r.get("candidates"):
        raise AIError(" ".join(["blocked"] + _codes((r.get("promptFeedback") or {}).get("blockReason"))))
    cand = r["candidates"][0]
    text = "".join(p.get("text", "") for p in (cand.get("content") or {}).get("parts") or [])
    if not text.strip():
        raise AIError(" ".join(["no text"] + _codes(cand.get("finishReason"))))
    return text


def _groq(prompt: str) -> str:
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        return ""
    r = post_json(
        "https://api.groq.com/openai/v1/chat/completions",
        {"model": GROQ_MODEL, "messages": [{"role": "user", "content": prompt}]},
        timeout=30, headers={"Authorization": f"Bearer {key}"},
    )
    _check_error(r)
    choice = (r.get("choices") or [{}])[0]
    text = (choice.get("message") or {}).get("content") or ""
    if not text.strip():
        raise AIError(" ".join(["no text"] + _codes(choice.get("finish_reason"))))
    return text


PROVIDERS = (("gemini", _gemini), ("groq", _groq))
MAX_FAILS = 3  # failures in a row (timeouts, 5xx) before a provider is left alone for the rest of the run


class Health:
    """How the providers did this run: summaries each one wrote, why they failed, and which were paused. A paused
    provider isn't asked again until the next run, so a used-up quota doesn't cost 30 s for every posting."""

    def __init__(self):
        self.reset()

    def reset(self) -> None:
        self.used, self.failed = Counter(), Counter()
        self.streak, self.paused = Counter(), {}

    def ok(self, name: str) -> None:
        self.used[name] += 1
        self.streak[name] = 0

    def fail(self, name: str, reason: str, pause: bool) -> None:
        self.failed[f"{name}: {reason}"] += 1
        self.streak[name] += 1
        if (pause or self.streak[name] >= MAX_FAILS) and name not in self.paused:
            self.paused[name] = reason
            print(f"  summaries: {name} paused for this run ({reason})")

    def report(self) -> dict:
        """For the admin page and the log: counts and provider codes only."""
        return {"by": dict(self.used), "failed": dict(self.failed.most_common(6)), "paused": dict(self.paused)}

    def line(self) -> str:
        parts = [f"{k} {v}" for k, v in self.used.items()]
        paused = "; ".join(f"{k} paused: {v}" for k, v in self.paused.items())
        return "summaries: " + (", ".join(parts) or "none") + (f" ({paused})" if paused else "")


HEALTH = Health()


def _reason(e: Exception) -> tuple:
    """A short reason safe for a public log, and whether to stop asking this provider for the run."""
    if isinstance(e, AIError):
        return str(e), e.pause
    if isinstance(e, urllib.error.HTTPError):  # an error page that wasn't JSON
        return f"HTTP {e.code}", str(e.code) in _PAUSE
    if isinstance(e, (TimeoutError, urllib.error.URLError, OSError)):
        return "timeout or network", False
    return type(e).__name__, False


def _conditions_line(warnings: list, labels: dict, lang: str) -> str:
    parts = [f"{w.label(labels, lang)} – „{w.quote}“" if w.mandatory else w.label(labels, lang) for w in warnings]
    return f"⚠️ {t(lang, 'sum.conditions')}: " + "; ".join(parts)


def _mentions(summary: str, w, labels: dict) -> bool:
    names = {w.value.split(" (")[0], labels.get(w.value.split(" (")[0], "")}
    return any(n and re.search(re.escape(n[:6]), summary, re.I) for n in names)


def ensure_lines(summary: str, job: Job, warnings: list, labels: dict, lang: str = "en") -> str:
    """Puts back conditions and pay the model dropped; they matter more than anything else in the message."""
    lines = summary.splitlines() if summary else []
    if warnings and not all(_mentions(summary, w, labels) for w in warnings):
        lines = [l for l in lines if not l.startswith("⚠️")]
        lines.insert(0, _conditions_line(warnings, labels, lang))
    salary = job.salary or find_salary(job.description_text)
    if salary and not any(l.startswith("💰") for l in lines):
        lines.insert(1 if lines and lines[0].startswith("⚠️") else 0, f"💰 {t(lang, 'sum.salary')}: {salary}")
    return "\n".join(lines)


def fallback(job: Job, warnings: list, labels: dict, lang: str = "en") -> str:
    lines = []
    if warnings:
        lines.append(_conditions_line(warnings, labels, lang))
    salary = job.salary or find_salary(job.description_text)
    if salary:
        lines.append(f"💰 {t(lang, 'sum.salary')}: {salary}")
    lines.append(f"{t(lang, 'sum.what')}: " + first_sentences(job.description_text, 220))
    return "\n".join(lines)


def summarize(job: Job, warnings: list = (), labels: dict = None, lang: str = "en", country: str = "",
              languages: str = "English") -> tuple:
    """Returns (summary, provider). Provider "none" means the local fallback was used."""
    labels = labels or {}
    prompt = _prompt(job, lang, country, languages)
    for name, fn in PROVIDERS:
        if name in HEALTH.paused:
            continue
        try:
            text = _clean(fn(prompt))
        except Exception as e:  # quota, refused key, timeout, odd answer: the next provider, then the local summary
            reason, pause = _reason(e)
            HEALTH.fail(name, reason, pause)
            print(f"  summary via {name} failed: {reason}")
            continue
        if text:
            HEALTH.ok(name)
            return ensure_lines(text, job, list(warnings), labels, lang), name
    HEALTH.ok("none")
    return fallback(job, list(warnings), labels, lang), "none"
