// Reads a CV inside the browser and suggests settings from it: field, specializations, level, languages, skills,
// city. Nothing is uploaded: the file never leaves the person's computer, and no AI is involved.
const LIBS = {
  pdf: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  pdfWorker: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  docx: "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js",
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("library_failed"));
    document.head.append(s);
  });
}

export async function fileText(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith(".txt")) return file.text();
  if (name.endsWith(".pdf")) {
    await loadScript(LIBS.pdf);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
    const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let i = 1; i <= Math.min(pdf.numPages, 10); i++) {
      const content = await (await pdf.getPage(i)).getTextContent();
      pages.push(content.items.map((it) => it.str + (it.hasEOL ? "\n" : " ")).join(""));
    }
    return pages.join("\n");
  }
  if (name.endsWith(".docx")) {
    await loadScript(LIBS.docx);
    return (await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
  }
  throw new Error("unsupported_file");
}

export const fold = (s) => (s || "").replace(/đ/g, "dj").replace(/Đ/g, "Dj").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const count = (text, word) => (text.match(new RegExp(`(?<![\\w])${esc(fold(word))}(?![\\w])`, "g")) || []).length;
const has = (text, word) => count(text, word) > 0;

const LEVEL_WORDS = [
  ["native", /native|mother tongue|maternji|bilingual/],
  ["advanced", /\bc[12]\b|fluent|proficient|advanced|napredn|tecno/],
  ["intermediate", /\bb[12]\b|intermediate|srednj|good|dobro/],
  ["basic", /\ba[12]\b|basic|elementary|beginner|osnovn/],
];

function yearsOfExperience(text) {
  const said = [...text.matchAll(/(\d{1,2})\+?\s*(?:years|yrs|godin)/g)].map((m) => Number(m[1])).filter((n) => n > 0 && n < 45);
  if (said.length) return Math.max(...said);
  const now = new Date().getFullYear();
  const starts = [...text.matchAll(/((?:19|20)\d{2})\s*[-–—]\s*((?:19|20)\d{2}|present|now|current|today|danas|sada|trenutno)/g)]
    .map((m) => Number(m[1])).filter((y) => y > now - 45 && y <= now);
  return starts.length ? now - Math.min(...starts) : 0;
}

// what the CV suggests, in the shape of the user's settings
export function scan(rawText, options, countryCode) {
  const text = fold(rawText);
  const head = fold(rawText.split("\n").slice(0, 25).join("\n")); // name, title, summary: where the role is stated

  const fields = options.families.map((f) => {
    const titles = f.title_keywords.reduce((n, k) => n + 3 * count(head, k) + count(text, k), 0);
    const skills = Object.entries(f.skill_aliases).filter(([, aliases]) => aliases.some((a) => has(text, a))).length;
    return { f, score: titles * 2 + skills };
  }).sort((a, b) => b.score - a.score);
  const best = fields[0]?.score > 0 ? fields[0].f : null;

  const skills = new Map();
  for (const f of options.families) {
    for (const [name, aliases] of Object.entries(f.skill_aliases)) {
      if (aliases.some((a) => has(text, a))) skills.set(name, "strong");
    }
  }

  const languages = [];
  for (const l of options.languages) {
    const names = [l.name, l.label].filter(Boolean);
    const line = rawText.split("\n").find((ln) => names.some((n) => has(fold(ln), n)));
    if (!line) continue;
    const level = (LEVEL_WORDS.find(([, re]) => re.test(fold(line))) || ["intermediate"])[0];
    languages.push({ name: l.name, level });
  }

  const years = yearsOfExperience(text);
  const seniority = years >= 5 ? ["senior"] : years >= 2 ? ["medior", "senior"] : years > 0 ? ["junior", "medior"] : [];
  const specializations = best ? Object.entries(best.specialization_keywords)
    .filter(([, kws]) => kws.some((k) => has(text, k))).map(([id]) => id) : [];
  const country = options.countries.find((c) => c.code === countryCode);
  const cities = (country?.cities || []).filter((c) => has(text, c.name)).map((c) => c.id);

  return {
    field: best && { id: best.id, specializations: specializations.length ? specializations : best.specializations.map((s) => s.id) },
    alternatives: fields.slice(1, 3).filter((x) => x.score > 0 && best && x.score >= fields[0].score / 2).map((x) => x.f.id),
    years, seniority, languages, skills: [...skills].map(([name, level]) => ({ name, level })), cities,
    words: text.split(/\s+/).length,
  };
}
