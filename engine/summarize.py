"""Summary of a posting in the user's language: conditions first, then pay, level, skills, what you'd do.
Only the public posting text is sent to the AI providers. Locally detected conditions and salary are
guaranteed to appear even if the model leaves them out."""
from __future__ import annotations

import os
import re

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


def _gemini(prompt: str) -> str:
    key = os.environ.get("GEMINI_API_KEY")
    if not key:
        return ""
    r = post_json(
        f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent",
        {"contents": [{"parts": [{"text": prompt}]}]},
        timeout=30, headers={"x-goog-api-key": key},
    )
    return r["candidates"][0]["content"]["parts"][0]["text"]


def _groq(prompt: str) -> str:
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        return ""
    r = post_json(
        "https://api.groq.com/openai/v1/chat/completions",
        {"model": GROQ_MODEL, "messages": [{"role": "user", "content": prompt}]},
        timeout=30, headers={"Authorization": f"Bearer {key}"},
    )
    return r["choices"][0]["message"]["content"]


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
    for name, fn in (("gemini", _gemini), ("groq", _groq)):
        try:
            text = _clean(fn(prompt))
            if text:
                return ensure_lines(text, job, list(warnings), labels, lang), name
        except Exception as e:  # network, quota, unexpected shape: try the next provider
            print(f"  summary via {name} failed: {type(e).__name__}")
    return fallback(job, list(warnings), labels, lang), "none"
