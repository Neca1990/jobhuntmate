"""AI summaries: why a provider failed is logged as its codes only (the log is public), a provider whose quota is
gone or whose key is refused is left alone for the rest of the run, and the local summary always comes last."""
import urllib.error

import pytest

from engine import summarize
from engine.models import Job

JOB = Job(source="x", url="https://example.com/1", title="QA Engineer", company="Acme",
          description_text="We test mobile apps. Salary 3000 EUR. Appium, Java.")
SECRET = "Quota exceeded for project 123456789, see https://console.example/key=abc"


@pytest.fixture
def keys(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "x")
    monkeypatch.setenv("GROQ_API_KEY", "x")


def answering(monkeypatch, answers, calls=None):
    def post(url, body, **kw):
        name = "gemini" if "googleapis" in url else "groq"
        if calls is not None:
            calls.append(name)
        a = answers[name]
        if isinstance(a, Exception):
            raise a
        return a
    monkeypatch.setattr(summarize, "post_json", post)


def test_quota_errors_are_logged_by_code_without_the_providers_wording(keys, monkeypatch, capsys):
    answering(monkeypatch, {"gemini": {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED", "message": SECRET}},
                            "groq": {"error": {"type": "rate_limit_exceeded", "message": SECRET}}})
    text, provider = summarize.summarize(JOB)
    out = capsys.readouterr().out
    assert provider == "none" and "3000" in text
    assert "gemini failed: 429 RESOURCE_EXHAUSTED" in out and "groq failed: rate_limit_exceeded" in out
    assert "123456789" not in out and "key=" not in out and "Quota" not in out


def test_a_used_up_provider_is_not_asked_again_this_run(keys, monkeypatch):
    calls = []
    answering(monkeypatch, {"gemini": {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED"}},
                            "groq": {"choices": [{"message": {"content": "Nivo: Senior"}}]}}, calls)
    assert [summarize.summarize(JOB)[1] for _ in range(3)] == ["groq"] * 3
    assert calls == ["gemini", "groq", "groq", "groq"]
    assert summarize.HEALTH.report() == {"by": {"groq": 3}, "failed": {"gemini: 429 RESOURCE_EXHAUSTED": 1},
                                         "paused": {"gemini": "429 RESOURCE_EXHAUSTED"}}
    summarize.HEALTH.reset()  # the next run asks it again
    summarize.summarize(JOB)
    assert calls[-2:] == ["gemini", "groq"]


def test_passing_trouble_pauses_only_after_three_in_a_row(keys, monkeypatch):
    calls = []
    answering(monkeypatch, {"gemini": urllib.error.URLError("timed out"),
                            "groq": {"choices": [{"message": {"content": "Nivo: Senior"}}]}}, calls)
    for _ in range(4):
        summarize.summarize(JOB)
    assert calls.count("gemini") == 3 and summarize.HEALTH.paused == {"gemini": "timeout or network"}


def test_blocked_or_empty_answers_say_why(keys, monkeypatch):
    for answer, reason in (({"promptFeedback": {"blockReason": "SAFETY"}}, "blocked SAFETY"),
                           ({"candidates": [{"finishReason": "MAX_TOKENS", "content": {}}]}, "no text MAX_TOKENS"),
                           ({"candidates": [{"content": {"parts": [{"text": "Nivo: "}, {"text": "Senior"}]}}]}, None)):
        answering(monkeypatch, {"gemini": answer, "groq": {}})
        if reason:
            with pytest.raises(summarize.AIError, match=reason):
                summarize._gemini("p")
        else:
            assert summarize._gemini("p") == "Nivo: Senior"  # an answer in several parts is joined
    answering(monkeypatch, {"gemini": {}, "groq": {"choices": [{"message": {"content": None}, "finish_reason": "length"}]}})
    with pytest.raises(summarize.AIError, match="no text length"):
        summarize._groq("p")


def test_odd_codes_never_reach_the_log(keys, monkeypatch):
    answering(monkeypatch, {"gemini": {"error": {"code": 400, "status": "INVALID ARGUMENT: key=abc", "message": SECRET}},
                            "groq": {"error": "something went wrong at https://x/?key=abc"}})
    summarize.summarize(JOB)
    assert summarize.HEALTH.report()["failed"] == {"gemini: 400": 1, "groq: error": 1}
    assert summarize.HEALTH.line() == "summaries: none 1"
