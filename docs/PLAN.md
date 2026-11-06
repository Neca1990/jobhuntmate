# Plan

## Decisions (2026-11-05)

| Topic | Decision |
|---|---|
| Name | JobHuntMate, kept only in `config/brand.json` so it can change later |
| Login | Telegram code (bot sends a one-time code) via a pluggable provider module; Google and email code when there is a domain; Cloudflare Access only if a card is added |
| Registration | invite-only at start; admin switch "invited only / everyone" |
| CV tailoring | manual for now (the owner asks Claude); admin switch to Claude API with a monthly cap (default $5, editable by admin) and a per-user limit |
| Job areas | all IT: QA, Backend, Frontend, Mobile, DevOps/Cloud, Data/ML, AI, Product/Project, UX/UI, Security, IT support/Sysadmin |
| Notifications | a channel interface; Telegram and email (links to posting and dashboard) first, others (web push, Discord, WhatsApp) later |
| Telegram bot | username `job_alerts_notify_bot`, display name from `brand.json` |

## Architecture

- Site: Cloudflare Pages.
- API, auth check, Telegram webhook: Cloudflare Workers.
- Data: D1 (users, searches, applications, recruiters), R2 (CVs).
- Job search: this repo's GitHub Actions (public repo → unlimited minutes). Hourly: load every user's searches,
  fetch each source once, filter and score per user, notify per user, write results back.

## Phases

0. Decisions and accounts: name, repo, bot, Cloudflare project. **(done)**
1. Copy from the single-user job-hunter, strip personal data, per-user config, tests green. **(done)**
2. Accounts and database: D1 (EU), API, Telegram sign-in, admin settings, invites. **(done, waiting for secrets)**
3. Dashboard on the new API; onboarding wizard; "Connect Telegram". **(done: searches, applications, account, admin; Telegram connects at sign-in)**
4. Search for everyone: fetch once, filter per user, channels, click handling.
5. Applications, shared recruiter catalog, CV storage; optional Claude API.
6. Privacy and safety: terms, delete/export account, clean public logs, abuse limits.
7. Trial with 1–2 users, then open.

## Before making the repo public

No personal data in code, config or history; logs print counts only.

## Later

- **Live updates over a WebSocket** once there are more users: the Applications tab now polls (3 s while the person is
  active, 30 s when idle), and every poll counts against Cloudflare's free 100,000 API requests a day (roughly 10 users
  with the tab open all day). A Durable Object per user with WebSocket hibernation pushes changes only when they
  happen. The poll in site/app.js (refreshApplications) is the one place to replace.
- With a domain: Google sign-in, email-code sign-in, email notifications (see the decisions above).
- **Per-user "search all postings"** (phase 5, to discuss): postings gathered by full scans are kept in the database and
  a user's button matches their searches against them – no new requests to job sites; once a day per user.
