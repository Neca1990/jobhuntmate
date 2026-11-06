"""The owner's side of "make me a CV and email": list what users asked for, fetch the CV they chose, and send back
the finished CV and email. Runs on the owner's Mac with the engine key (~/.jobhuntmate/engine_key).

  python3 tools/requests.py list
  python3 tools/requests.py file <file id> <where to save>
  python3 tools/requests.py done <request id> --subject "…" --body email.txt [--to address] [--cv tailored.pdf]
"""
from __future__ import annotations

import argparse
import base64
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = json.loads((ROOT / "config" / "brand.json").read_text())["site_url"].rstrip("/")
KEY = Path("~/.jobhuntmate/engine_key").expanduser().read_text().strip()


def call(method: str, path: str, body=None, raw: bool = False):
    req = urllib.request.Request(f"{SITE}/api/engine/{path}", method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"authorization": f"Bearer {KEY}", "content-type": "application/json",
                                          "user-agent": "owner-tools/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    return data if raw else json.loads(data)


def show(r: dict) -> str:
    a, u = r["agency"] or {}, r["user"]
    lines = [f"{r['id']}  {r['created_at'][:16]}  for {u['name'] or u['id'][:8]} ({u['language']}, {u['country']})",
             f"   agency: {a.get('name', '?')}  <{a.get('email') or 'no email'}>  apply: {a.get('nacin_prijave', 'email')}"]
    for key in ("email_opis", "prijava_link", "obrazac"):
        if a.get(key):
            lines.append(f"   {key}: {a[key]}")
    if r["note"]:
        lines.append(f"   {'CHANGE REQUESTED' if r['note'].startswith('CHANGE: ') else 'note'}: {r['note'].removeprefix('CHANGE: ')}")
    if r.get("user_note") and r["note"].startswith("CHANGE: "):
        lines.append(f"   original note: {r['user_note']}")
    if r.get("previous"):
        prev = r["previous"]
        lines.append(f"   previous version: CV {prev.get('cv_file_id') or '-'}; subject: {(prev.get('mail') or {}).get('subject', '-')}")
    lines.append(f"   start from: {r['file']['name'] + ' (' + r['file']['id'] + ')' if r['file'] else 'the owner’s general CV'}")
    return "\n".join(lines)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    f = sub.add_parser("file")
    f.add_argument("id")
    f.add_argument("out")
    d = sub.add_parser("done")
    d.add_argument("id")
    d.add_argument("--subject", default="")
    d.add_argument("--body", default="", help="file with the email text")
    d.add_argument("--to", default="")
    d.add_argument("--cv", default="", help="the tailored CV (PDF)")
    a = p.parse_args(argv)

    if a.cmd == "list":
        reqs = call("GET", "requests")["requests"]
        print("\n\n".join(show(r) for r in reqs) if reqs else "Nothing is waiting.")
        return 0
    if a.cmd == "file":
        Path(a.out).write_bytes(call("GET", f"files/{a.id}", raw=True))
        print(f"saved {a.out}")
        return 0
    body = {}
    if a.subject or a.body:
        body["mail"] = {"to": a.to, "subject": a.subject, "body": Path(a.body).read_text() if a.body else ""}
        if not a.to:
            waiting = {r["id"]: r for r in call("GET", "requests")["requests"]}
            body["mail"]["to"] = ((waiting.get(a.id) or {}).get("agency") or {}).get("email", "")
    if a.cv:
        cv = Path(a.cv).expanduser()
        body["file"] = {"name": cv.name, "data": base64.b64encode(cv.read_bytes()).decode()}
    call("PUT", f"requests/{a.id}", body)
    print("done – the user sees it on the site")
    return 0


if __name__ == "__main__":
    sys.exit(main())
