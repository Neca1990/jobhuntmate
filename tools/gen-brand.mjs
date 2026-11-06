// Writes functions/_lib/brand.gen.js from config/brand.json, so the API reads the name from the one place it is
// written down. Run before deploying and testing (the scripts do it).
import { readFileSync, writeFileSync } from "node:fs";

const brand = JSON.parse(readFileSync(new URL("../config/brand.json", import.meta.url)));
writeFileSync(new URL("../functions/_lib/brand.gen.js", import.meta.url),
  `// generated from config/brand.json by tools/gen-brand.mjs – do not edit\nexport default ${JSON.stringify(brand, null, 2)};\n`);

const geo = JSON.parse(readFileSync(new URL("../config/geo.json", import.meta.url)));
writeFileSync(new URL("../functions/_lib/geo.gen.js", import.meta.url),
  `// generated from config/geo.json by tools/gen-brand.mjs – do not edit\nexport const TIMEZONES = ${JSON.stringify(
    Object.fromEntries(geo.countries.map((c) => [c.code, c.timezone])))};\n`);
