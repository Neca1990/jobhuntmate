# JobHuntMate

Finds new IT job postings for each user and sends them where they want (Telegram, email). Every user has their own
account and dashboard: searches, applications, recruiters.

Status: phase 1 done (multi-user search engine, file storage). See [docs/PLAN.md](docs/PLAN.md).

## Layout

- `engine/` – the search: `run.py` (one run for every user), `filters.py`, `requirements.py`, `cards.py` (the message),
  `channels/` (Telegram, email; one module per channel), `geo.py` (countries, regions, cities), `i18n.py` (texts),
  `store.py` (where users and their data live).
- `engine/plugins/` – not in this repository: the job sites and company-site checks live in a private one and are
  checked out here when the search runs.
- `config/` – shared settings: `brand.json`, `taxonomy.json` (job families), `geo.json`,
  `languages.json`. Company job boards found so far are kept in the site's database, not here.
- `examples/user.example.json` – what one user's settings look like (a made-up person).

## Run

```
python3 -m engine.run --dry-run     # prints the messages instead of sending
python3 -m pytest -q
```

## Renaming

The product name, site address and bot live in one place: [config/brand.json](config/brand.json). Code and pages
read them from there; nothing else hardcodes the name. To rename: edit that file, rename the Telegram bot's display
name in @BotFather, and (if the address changes) point the old site address at the new one.
