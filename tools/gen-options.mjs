// Writes site/options.json: what the dashboard lets people choose from (job families, places, languages),
// taken from config/ so the choices always match what the search understands.
import { readFileSync, writeFileSync } from "node:fs";

const read = (f) => JSON.parse(readFileSync(new URL(`../config/${f}`, import.meta.url)));
const taxonomy = read("taxonomy.json");
const geo = read("geo.json");
const languages = read("languages.json");

const options = {
  families: taxonomy.families.map((f) => ({ id: f.id, name: f.name, names: f.names || {},
    specializations: f.specializations.map((s) => ({ id: s.id, name: s.name, names: s.names || {} })),
    skills: f.skills_catalog.map((s) => s.name),
    // for reading a CV in the browser: which words mean which skill, and which job titles mean this field
    skill_aliases: Object.fromEntries(f.skills_catalog.map((s) => [s.name, s.aliases || [s.name.toLowerCase()]])),
    title_keywords: f.title_keywords,
    specialization_keywords: Object.fromEntries(f.specializations.map((s) => [s.id, s.keywords])) })),
  seniority: taxonomy.seniority.map((s) => ({ id: s.id, name: s.name })),
  employment_types: taxonomy.employment_types.map((t) => ({ id: t.id, name: t.name })),
  countries: geo.countries.map((c) => ({ code: c.code, name: c.name, timezone: c.timezone,
    cities: c.cities.map((x) => ({ id: `city:${x.id}`, name: x.name })) })),
  // the job sites are not listed here: this file is public, and which sites are searched isn't
  languages: languages.languages.map((l) => ({ name: l.name, label: l.label || l.name })),
  levels: languages.levels || [],
};
writeFileSync(new URL("../site/options.json", import.meta.url), JSON.stringify(options));
