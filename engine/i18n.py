"""Every text a user reads, per language. A missing key falls back to English."""
from __future__ import annotations

LANGUAGES = ("en", "sr")

TEXTS = {
    "en": {
        # requirements
        "req.language": "language: {name}",
        "req.nice": " (nice to have)",
        "req.native": "{name} (native)",
        "req.residency": "location/residency",
        "req.citizenship": "citizenship",
        "req.clearance": "security clearance",
        # summary
        "sum.conditions": "Conditions",
        "sum.salary": "Salary",
        "sum.what": "What you'd do",
        "sum.prompt": """You summarise a job posting for a candidate who lives in {country} and speaks {languages}.
Answer in English, exactly in this order, each item on its own line, no intro and no markdown:
⚠️ Conditions: every condition that could exclude the candidate – a required language other than English, location or residency, citizenship, time zone, contract type (e.g. B2B/freelance), security clearance. When a condition is mandatory, quote it word for word from the posting. If there are none, leave the whole line out.
💰 Salary: the amount exactly as the posting states it. If no salary is given, leave the whole line out.
Level: short (e.g. Senior, 5+ years).
Must have: the most important required skills, short.
Nice to have: short; leave the line out if none.
What you'd do: one sentence on the product/domain and main tasks.
Never leave out a language requirement or the salary if the posting has them.

KEY LINES FROM THE POSTING (conditions, pay, location):
{key}

FULL POSTING:
{text}""",
        "sum.none": "(none)",
        # job card
        "card.match": "Match: <b>{score}/10</b>",
        "card.basic": "{skill} (basic)",
        "card.no_tech": "ℹ️ The posting names no specific technologies.",
        "card.type_unknown": "type not stated",
        "card.level_unknown": "level not stated",
        "card.place_unknown": "not stated",
        "card.countries": "{n} countries",
        "card.countries_incl": "{n} countries, including {country}",
        "card.link": "Posting on {source}",
        "card.company_link": "Posting on the company site",
        "card.site_active_broken": "🏢 Company site ({board}): ✅ the posting exists, but their posting page doesn't load – apply via {source}",
        "card.site_active_checked": "🏢 Company site ({board}): ✅ posting is live, link checked",
        "card.site_active": "🏢 Posting is from the company site: ✅ live",
        "card.site_missing": "🏢 Company site ({board}): ⚠️ posting NOT found there (the company has {others} other postings) – only on {source}",
        "card.site_none": "🏢 Company site: ❌ not found – the company has no public jobs page to check, apply via {source}",
        "card.places": "🌍 Where from (company site): {places}",
        "card.letter": "✉️ Cover letter: {value}",
        "card.letter.required": "required",
        "card.letter.optional": "optional",
        "card.letter.off": "the form doesn't take one",
        "card.letter.text": "mentioned in the posting",
        "card.letter.unknown": "not stated",
        "card.questions": "📝 Required questions in the form: {questions}",
        "card.expires": "⏳ Closes: {date} (in {days} d, {where})",
        "card.expires.text": "deadline from the posting",
        "card.expires.source": "when {source} takes it down",
        "card.no_deadline": "⏳ No application deadline given",
        # buttons and statuses
        "btn.approve": "✅ Approve",
        "btn.skip": "❌ Skip",
        "btn.sent": "📨 I've applied",
        "status.pending": "Waiting for approval",
        "status.approved": "✅ Approved – CV to do",
        "status.ready": "📄 CV ready – review",
        "status.sent": "📨 Applied",
        "status.skipped": "❌ Skipped",
        "status.rejected": "Rejected",
        "status.no_reply": "No reply",
        # notices
        "notice.more_waiting": "📬 {n} more postings are waiting – they come in the next round.",
        "notice.blocked": "⛔ {message}. Skipping it, will try again on schedule.",
    },
    "sr": {
        "req.language": "jezik: {name}",
        "req.nice": " (poželjno)",
        "req.native": "{name} (maternji)",
        "req.residency": "lokacija/boravak",
        "req.citizenship": "državljanstvo",
        "req.clearance": "bezbednosna provera",
        "sum.conditions": "Uslovi",
        "sum.salary": "Plata",
        "sum.what": "Šta bi radio",
        "sum.prompt": """Sažimaš oglas za posao za kandidata koji živi u zemlji {country} i govori: {languages}.
Odgovori na srpskom (latinica), tačno ovim redom, svaka stavka u svom redu, bez uvoda i bez markdown-a:
⚠️ Uslovi: svi uslovi koji mogu isključiti kandidata – obavezan jezik osim engleskog, lokacija ili boravak, državljanstvo, vremenska zona, tip ugovora (npr. B2B/freelance), bezbednosna provera. Kada je uslov obavezan, citiraj ga doslovno iz oglasa pod navodnicima. Ako takvih uslova nema, izostavi ceo red.
💰 Plata: iznos tačno kako piše u oglasu. Ako plata nije navedena, izostavi ceo red.
Nivo: kratko (npr. Senior, 5+ godina).
Obavezno: najvažnije tražene veštine, kratko.
Poželjno: kratko; izostavi red ako nema.
Šta bi radio: jedna rečenica o proizvodu/domenu i glavnim zadacima.
Nikada ne izostavljaj zahtev za jezikom ni platu ako postoje u oglasu.

KLJUČNI REDOVI IZ OGLASA (uslovi, plata, lokacija):
{key}

CEO OGLAS:
{text}""",
        "sum.none": "(nema)",
        "card.match": "Ocena poklapanja: <b>{score}/10</b>",
        "card.basic": "{skill} (osnovno)",
        "card.no_tech": "ℹ️ U oglasu nisu navedene konkretne tehnologije.",
        "card.type_unknown": "tip nije naveden",
        "card.level_unknown": "nivo nije naveden",
        "card.place_unknown": "nije navedeno",
        "card.countries": "{n} zemalja",
        "card.countries_incl": "{n} zemalja, uključujući: {country}",
        "card.link": "Oglas na {source}",
        "card.company_link": "Oglas na sajtu firme",
        "card.site_active_broken": "🏢 Sajt firme ({board}): ✅ oglas postoji, ali njihova stranica oglasa ne radi – prijavi se preko {source}",
        "card.site_active_checked": "🏢 Sajt firme ({board}): ✅ oglas je aktivan, link proveren",
        "card.site_active": "🏢 Oglas je sa sajta firme: ✅ aktivan",
        "card.site_missing": "🏢 Sajt firme ({board}): ⚠️ oglas tamo NIJE pronađen (firma ima {others} drugih oglasa) – postoji samo na {source}",
        "card.site_none": "🏢 Sajt firme: ❌ oglas nije pronađen – firma nema javnu stranicu sa oglasima koju mogu da proverim, prijava ide preko {source}",
        "card.places": "🌍 Rad odakle (sajt firme): {places}",
        "card.letter": "✉️ Propratno pismo: {value}",
        "card.letter.required": "obavezno",
        "card.letter.optional": "opciono",
        "card.letter.off": "forma ga ne prima",
        "card.letter.text": "pominje se u oglasu",
        "card.letter.unknown": "nije navedeno",
        "card.questions": "📝 Obavezna pitanja u formi: {questions}",
        "card.expires": "⏳ Ističe: {date} (za {days} d, {where})",
        "card.expires.text": "rok iz oglasa",
        "card.expires.source": "tada ga {source} skida",
        "card.no_deadline": "⏳ Rok prijave nije naveden",
        "btn.approve": "✅ Odobri",
        "btn.skip": "❌ Preskoči",
        "btn.sent": "📨 Poslao sam",
        "status.pending": "Čeka odobrenje",
        "status.approved": "✅ Odobreno – čeka CV",
        "status.ready": "📄 CV spreman – pregledaj",
        "status.sent": "📨 Poslato",
        "status.skipped": "❌ Preskočeno",
        "status.rejected": "Odbijeno",
        "status.no_reply": "Bez odgovora",
        "notice.more_waiting": "📬 Još {n} oglasa čeka – stižu u sledećem krugu.",
        "notice.blocked": "⛔ {message}. Preskačem i probaću ponovo po rasporedu.",
    },
}


def t(lang: str, key: str, /, **kw) -> str:
    text = TEXTS.get(lang, {}).get(key) or TEXTS["en"][key]
    return text.format(**kw) if kw else text
