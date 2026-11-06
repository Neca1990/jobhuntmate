// Copies site/ to build/ with a version stamp: "__V__" in pages and scripts becomes the version, so browsers fetch
// the new files after a deploy, and build/version.json tells open pages that a new version is out. "__BRAND__" in
// pages without scripts (the privacy notice) becomes the site's name from config/brand.json.
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const src = new URL("../site/", import.meta.url);
const out = new URL("../build/", import.meta.url);
const now = new Date();
const local = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Belgrade", dateStyle: "short", timeStyle: "medium" }).format(now);
const brand = JSON.parse(readFileSync(new URL("../config/brand.json", import.meta.url), "utf8"));
const version = local.replace(/[-: ]/g, "").slice(0, 14); // 20261106023015: two deploys in one minute still differ

rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });
for (const f of readdirSync(out)) {
  if (/\.(html|js|css)$/.test(f)) {
    const path = new URL(f, out);
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("__V__", version).replaceAll("__BRAND__", brand.name));
  }
}
writeFileSync(new URL("version.json", out), JSON.stringify({ version }));
console.log(`version ${version}`);
