// The site: sign in with Telegram, then the dashboard (searches, applications, account, admin).
// Everything comes from the API (/api/*) and options.json (the choices the search understands).
import { LANGS, lang, nameOf, setLang, t } from "./i18n.js?v=__V__";

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "checked" || k === "value" || k === "selected") node[k] = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children)) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}
const store = {
  get: (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private window: nothing to remember */ } },
};

const state = { brand: {}, options: null, me: null, settings: null, dirty: false, apps: [], tab: "searches",
  login: { token: "", pushed: false, timer: 0 } };

async function api(method, path, body) {
  const r = await fetch(path, { method, credentials: "same-origin", headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || "error"), { code: data.error || "default", status: r.status });
  return data;
}
const errText = (code) => t(`err.${code}`) === `err.${code}` ? t("err.default") : t(`err.${code}`);

// ---------- language and static texts ----------
function paintStatic() {
  document.documentElement.lang = lang();
  $$("[data-t]").forEach((n) => { n.textContent = t(n.dataset.t); });
  $$("[data-brand-name]").forEach((n) => { n.textContent = state.brand.name || ""; });
  const tag = state.brand.tagline || "";
  $$("[data-brand-tagline]").forEach((n) => { n.textContent = typeof tag === "string" ? tag : (tag[lang()] || tag.en || ""); });
  document.title = state.brand.name || "";
  $$("[data-lang-switch]").forEach((box) => box.replaceChildren(...LANGS.map((l) => el("button", {
    class: `small ${l === lang() ? "" : "ghost"}`, text: l.toUpperCase(),
    onclick: () => changeLang(l) }))));
}
function changeLang(l) {
  setLang(l);
  store.set("lang", l);
  if (state.settings && state.settings.language !== l) { state.settings.language = l; markDirty(); }
  paintStatic();
  if (state.me) renderApp();
  else $("#where").textContent = state.login.pushed ? t("where_pushed") : t("where_link");
}

// ---------- sign in ----------
function showLogin(step = "start") {
  clearTimeout(state.login.timer);
  $("#loader").classList.add("hidden");
  $("#app").classList.add("hidden");
  $("#login").classList.remove("hidden");
  $("#step-start").classList.toggle("hidden", step !== "start");
  $("#step-wait").classList.toggle("hidden", step !== "wait");
  $("#login-error").textContent = "";
}
const loginError = (code) => { $("#login-error").textContent = errText(code); };
const invite = new URLSearchParams(location.search).get("invite") || "";

$("#start").addEventListener("click", async () => {
  try {
    const username = $("#username").value.trim();
    const r = await api("POST", "/api/auth/telegram/start", { invite, username });
    Object.assign(state.login, { token: r.token, pushed: Boolean(username) });
    $("#match").textContent = r.match;
    $("#where").textContent = username ? t("where_pushed") : t("where_link");
    $("#bot-link").href = r.link;
    $("#bot-link").dataset.app = r.app_link;
    $("#code").value = "";
    $("#code-box").open = false;
    showLogin("wait");
    poll();
  } catch (e) { loginError(e.code); }
});
// asks every 2 seconds whether the number was tapped in Telegram
async function poll() {
  try {
    const r = await api("POST", "/api/auth/poll", { token: state.login.token });
    if (r.pending) { state.login.timer = setTimeout(poll, 2000); return; }
    await boot();
  } catch (e) {
    loginError(e.code);
    if (e.code === "login_expired") setTimeout(() => showLogin("start"), 2500);
  }
}
$("#verify").addEventListener("click", async () => {
  try {
    await api("POST", "/api/auth/verify", { token: state.login.token, code: $("#code").value });
    await boot();
  } catch (e) {
    loginError(e.code);
    if (["login_expired", "too_many_attempts"].includes(e.code)) setTimeout(() => showLogin("start"), 2500);
  }
});
$("#code").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#verify").click(); });
$("#restart").addEventListener("click", () => showLogin("start"));
// Phones: the t.me link itself opens the app when it is installed (and the web page when not).
// Computers: try the Telegram app first; if nothing takes over the page, open the web page in a new tab.
const phone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
$("#bot-link").addEventListener("click", (e) => {
  const app = e.currentTarget.dataset.app, web = e.currentTarget.href;
  e.preventDefault();
  if (phone || !app) { location.href = web; return; }
  let left = false;
  const away = () => { left = true; };
  window.addEventListener("blur", away, { once: true });
  location.href = app;
  setTimeout(() => {
    window.removeEventListener("blur", away);
    if (!left && !document.hidden) window.open(web, "_blank", "noopener");
  }, 1500);
});
$("#sign-out").addEventListener("click", async () => {
  await api("POST", "/api/auth/logout").catch(() => {});
  Object.assign(state, { me: null, settings: null, dirty: false });
  showLogin("start");
});

// ---------- the app ----------
const TABS = ["searches", "applications", "account", "admin"];
const STATUSES = ["pending", "approved", "ready", "sent", "test", "interview", "offer", "rejected", "skipped", "no_reply"];
const DEALBREAKERS = ["language", "residency", "citizenship", "clearance"];
const INTERVALS = [1, 2, 3, 4, 6, 8, 12, 24];
// a dropdown of times (every half hour) looks and works the same in every browser, unlike <input type=time>
const HALF_HOURS = Array.from({ length: 48 }, (_, i) => {
  const hm = `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`;
  return [hm, hm];
}).concat([["23:59", "23:59"]]);

async function boot() {
  try {
    state.me = await api("GET", "/api/me");
  } catch {
    showLogin("start");
    return;
  }
  // the job sites are listed only for signed-in users
  state.options.sources = (await api("GET", "/api/sources").catch(() => ({ sources: [] }))).sources;
  state.settings = structuredClone(state.me.settings || {});
  const draft = store.get(draftKey());
  if (draft) {
    try { state.settings = JSON.parse(draft); } catch { clearDraft(); }
    state.restored = draftDiffers();
    if (!state.restored) { state.settings = structuredClone(state.me.settings || {}); clearDraft(); }
  }
  if (state.settings.language && state.settings.language !== lang()) { setLang(state.settings.language); store.set("lang", lang()); }
  state.settings.language = lang();
  state.dirty = Boolean(state.restored);
  $("#loader").classList.add("hidden");
  $("#login").classList.add("hidden");
  $("#app").classList.remove("hidden");
  paintStatic();
  renderApp();
  if (state.restored) showRestored();
  else if (!(state.settings.searches || []).length) openOnboarding();
}

function renderApp() {
  const tabs = TABS.filter((x) => x !== "admin" || state.me.role === "admin");
  if (!tabs.includes(state.tab)) state.tab = "searches";
  $("#tabs").replaceChildren(...tabs.map((x) => el("button", { class: `tab ${x === state.tab ? "active" : ""}`, text: t(`tab.${x}`),
    onclick: () => { state.tab = x; saveView(); scrollTo(0, 0); renderApp(); } })));
  TABS.forEach((x) => $(`#tab-${x}`).classList.toggle("hidden", x !== state.tab));
  ({ searches: renderSearches, applications: renderApplications, account: renderAccount, admin: renderAdmin })[state.tab]();
  $("#savebar").classList.toggle("hidden", state.tab !== "searches");
  paintSaveStatus();
}

// unsaved edits are kept in this browser, so a reload or a closed tab doesn't lose them
const draftKey = () => `draft:${state.me?.id}`;

// The settings as they'd look with the same defaults the form fills in, compared without caring about order
// (ticking a box off and on again is no change), so only real edits count as unsaved.
function normalized(src) {
  const s = structuredClone(src || {});
  s.language ||= lang();
  s.country ||= "RS";
  s.searches ||= [];
  s.schedule = { interval_hours: 2, active_from: "08:00", active_to: "22:00", ...(s.schedule || {}) };
  s.max_messages_per_run ??= 8;
  s.max_age_days ??= 3;
  s.profile = { ...(s.profile || {}) };
  s.profile.languages ||= [];
  s.profile.skills = (s.profile.skills || []).filter((x) => x.level);
  s.dealbreakers = Object.fromEntries(Object.entries(s.dealbreakers || {}).filter(([, v]) => v !== "drop"));
  const defaults = Object.fromEntries((state.options?.sources || []).map((x) => [x.id, x.default]));
  s.sources_enabled = Object.fromEntries(Object.entries(s.sources_enabled || {}).filter(([k, v]) => v !== (defaults[k] ?? true)));
  s.searches = s.searches.map((x) => ({ include_keywords: [], exclude_keywords: [], ...x }));
  return s;
}
const canon = (v) => JSON.stringify(v, (k, x) => {
  if (Array.isArray(x)) {
    if (x.every((i) => typeof i === "string")) return [...x].sort();
    if (k !== "searches" && x.every((i) => i && typeof i === "object" && "name" in i)) return [...x].sort((a, b) => a.name.localeCompare(b.name));
    return x;
  }
  return x && typeof x === "object" ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x;
});
const unchanged = () => canon(normalized(state.settings)) === canon(normalized(state.me.settings));

// fields that differ from what is saved get a highlight; each tracked node knows how to read its value
let tracked = [];
function track(node, get) {
  tracked.push([node, get]);
  return node;
}
function paintDiffs() {
  const now = normalized(state.settings), saved = normalized(state.me?.settings);
  const read = (get, src) => { try { return canon(get(src)); } catch { return "?"; } };
  tracked = tracked.filter(([node]) => node.isConnected);
  for (const [node, get] of tracked) node.classList.toggle("changed", read(get, now) !== read(get, saved));
}

function markDirty() {
  state.dirty = !unchanged();
  if (state.dirty) store.set(draftKey(), JSON.stringify(state.settings));
  else { clearDraft(); state.restored = false; } // everything was put back as it was
  paintSaveStatus();
  paintDiffs();
}
function clearDraft() {
  try { localStorage.removeItem(draftKey()); } catch { /* nothing kept */ }
}
function showRestored() {
  const s = $("#save-status");
  s.className = "warn";
  s.replaceChildren(t("restored"), " ", el("button", { class: "ghost small", text: t("discard_changes"), onclick: () => {
    clearDraft();
    state.restored = false;
    state.settings = structuredClone(state.me.settings || {});
    state.dirty = false;
    renderApp();
  } }));
}
// the draft from last time is shown only if it really differs from what is saved
function draftDiffers() {
  return !unchanged();
}
function paintSaveStatus(text, cls = "") {
  const s = $("#save-status");
  s.textContent = text ?? (state.dirty ? t("unsaved") : "");
  s.className = text ? cls : "warn";
}

// ---------- searches & settings ----------
const opt = () => state.options;
const family = (id) => opt().families.find((f) => f.id === id) || opt().families[0];
const country = () => opt().countries.find((c) => c.code === (state.settings.country || "RS")) || opt().countries[0];

// get(settings) → the list this group edits (for highlighting ticks that differ from what is saved)
function chipGroup(title, items, selected, onChange, get) {
  return el("div", {}, [
    el("div", { class: "group-title", text: title }),
    el("div", { class: "chips" }, items.map((it) => {
      const chip = el("label", { class: "chip" }, [
        el("input", { type: "checkbox", checked: selected.includes(it.id), onchange: (e) => onChange(it.id, e.target.checked) }),
        it.label,
      ]);
      return get ? track(chip, (src) => (get(src) || []).includes(it.id)) : chip;
    })),
  ]);
}
const toggle = (list, id, on) => {
  const i = list.indexOf(id);
  if (on && i < 0) list.push(id);
  if (!on && i >= 0) list.splice(i, 1);
};
function selectEl(items, value, onChange, attrs = {}) {
  const s = el("select", attrs, items.map(([v, label]) => el("option", { value: v, text: label })));
  s.value = value;
  s.addEventListener("change", () => onChange(s.value));
  return s;
}
function wordsInput(list, onChange) {
  const i = el("input", { type: "text", placeholder: t("s.comma"), value: list.join(", ") });
  i.addEventListener("input", () => onChange(i.value.split(",").map((w) => w.trim()).filter(Boolean)));
  return i;
}

// "Where": remote, the cities of the user's country, and any town they type themselves ("place:<name>")
function placesBlock(s, redraw, get) {
  const typed = s.locations.filter((l) => l.startsWith("place:"));
  const items = [{ id: "remote", label: t("remote") }, ...country().cities.map((c) => ({ id: c.id, label: c.name })),
    ...typed.map((p) => ({ id: p, label: p.slice(6) }))];
  const input = el("input", { type: "text", placeholder: t("s.place_ph"), maxlength: 60, style: "min-width:240px" });
  const add = () => {
    const name = input.value.trim().replace(/\s+/g, " ");
    if (!name) return;
    const known = country().cities.find((c) => c.name.toLowerCase() === name.toLowerCase());
    const id = known ? known.id : `place:${name}`;
    if (!s.locations.includes(id)) s.locations.push(id);
    markDirty();
    redraw();
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });
  return el("div", {}, [
    chipGroup(t("s.locations"), items, s.locations, (id, on) => {
      toggle(s.locations, id, on);
      markDirty();
      if (!on && id.startsWith("place:")) redraw(); // a typed town disappears when unticked
    }, get),
    el("div", { class: "row", style: "justify-content:flex-start;margin:-4px 0 12px" }, [input,
      el("button", { class: "ghost small", type: "button", text: t("s.add_place"), onclick: add })]),
  ]);
}

function newSearch() {
  const f = opt().families[0];
  return { id: `s-${Date.now().toString(36)}`, name: nameOf(f), family: f.id, specializations: f.specializations.map((s) => s.id),
    seniority: ["medior", "senior"], employment_types: ["full_time", "contract"], locations: ["remote"],
    include_keywords: [], exclude_keywords: [] };
}

function searchCard(s, idx) {
  const st = state.settings;
  const f = family(s.family);
  const mine = (src) => src.searches.find((x) => x.id === s.id);
  return track(el("div", { class: "search" }, [
    el("div", { class: "row" }, [
      el("h3", { text: s.name || nameOf(f) }),
      el("button", { class: "danger small", text: t("s.remove"), onclick: () => { st.searches.splice(idx, 1); markDirty(); renderSearches(); } }),
    ]),
    el("div", { class: "grid" }, [
      track(el("label", {}, [t("s.name"), el("input", { type: "text", value: s.name || "", oninput: (e) => { s.name = e.target.value; markDirty(); } })]),
        (src) => mine(src)?.name),
      track(el("label", {}, [t("s.family"), selectEl(opt().families.map((x) => [x.id, nameOf(x)]), s.family, (v) => {
        s.family = v; s.specializations = family(v).specializations.map((x) => x.id); s.name = nameOf(family(v)); markDirty(); renderSearches();
      })]), (src) => mine(src)?.family),
    ]),
    chipGroup(t("s.specializations"), f.specializations.map((x) => ({ id: x.id, label: nameOf(x) })), s.specializations,
      (id, on) => { toggle(s.specializations, id, on); markDirty(); }, (src) => mine(src)?.specializations),
    chipGroup(t("s.seniority"), opt().seniority.map((x) => ({ id: x.id, label: x.name })), s.seniority,
      (id, on) => { toggle(s.seniority, id, on); markDirty(); }, (src) => mine(src)?.seniority),
    chipGroup(t("s.types"), opt().employment_types.map((x) => ({ id: x.id, label: x.name })), s.employment_types,
      (id, on) => { toggle(s.employment_types, id, on); markDirty(); }, (src) => mine(src)?.employment_types),
    placesBlock(s, renderSearches, (src) => mine(src)?.locations),
    el("div", { class: "grid" }, [
      track(el("label", {}, [t("s.include"), wordsInput(s.include_keywords || [], (w) => { s.include_keywords = w; markDirty(); })]),
        (src) => mine(src)?.include_keywords),
      track(el("label", {}, [t("s.exclude"), wordsInput(s.exclude_keywords || [], (w) => { s.exclude_keywords = w; markDirty(); })]),
        (src) => mine(src)?.exclude_keywords),
    ]),
  ]), (src) => Boolean(mine(src))); // a whole new (or removed) search
}

function renderSearches() {
  tracked = [];
  const st = state.settings;
  st.searches ||= [];
  st.schedule ||= { interval_hours: 2, active_from: "08:00", active_to: "22:00" };
  st.sources_enabled ||= {};
  st.profile ||= { languages: [], skills: [] };
  st.profile.languages ||= [];
  st.profile.skills ||= [];
  st.dealbreakers ||= {};
  const general = el("div", { class: "card" }, [el("div", { class: "grid" }, [
    track(el("label", {}, [t("language"), selectEl(LANGS.map((l) => [l, l === "sr" ? "Srpski" : "English"]), lang(), (v) => changeLang(v))]),
      (src) => src.language),
    track(el("label", {}, [t("country"), selectEl(opt().countries.map((c) => [c.code, c.name]), st.country || "RS", (v) => {
      st.country = v;
      const cities = new Set(country().cities.map((c) => c.id));
      st.searches.forEach((s) => { s.locations = s.locations.filter((l) => l === "remote" || l.startsWith("place:") || cities.has(l)); });
      markDirty();
      renderSearches();
    })]), (src) => src.country),
  ])]);
  const searches = el("div", { class: "card" }, [
    el("div", { class: "row" }, [el("h2", { text: t("s.searches") }),
      el("button", { class: "ghost small", text: t("s.add_search"), onclick: () => { st.searches.push(newSearch()); markDirty(); renderSearches(); } })]),
    ...st.searches.map(searchCard),
  ]);
  const sched = st.schedule;
  const schedule = el("div", { class: "card" }, [el("h2", { text: t("s.schedule") }), el("div", { class: "grid" }, [
    track(el("label", {}, [t("s.every"), selectEl(INTERVALS.map((h) => [String(h), t("s.every_h", { n: h })]), String(sched.interval_hours),
      (v) => { sched.interval_hours = Number(v); markDirty(); })]), (src) => src.schedule.interval_hours),
    track(el("label", {}, [t("s.from"), selectEl(HALF_HOURS, sched.active_from, (v) => { sched.active_from = v; markDirty(); })]),
      (src) => src.schedule.active_from),
    track(el("label", {}, [t("s.to"), selectEl(HALF_HOURS, sched.active_to, (v) => { sched.active_to = v; markDirty(); })]),
      (src) => src.schedule.active_to),
    track(el("label", {}, [t("s.max_messages"), selectEl(range(1, 30), String(st.max_messages_per_run ?? 8),
      (v) => { st.max_messages_per_run = Number(v); markDirty(); })]), (src) => src.max_messages_per_run),
    track(el("label", {}, [t("s.max_age"), selectEl(range(1, 60), String(st.max_age_days ?? 3),
      (v) => { st.max_age_days = Number(v); markDirty(); })]), (src) => src.max_age_days),
  ])]);
  const mine = opt().sources.filter((s) => !s.countries.length || s.countries.includes(st.country || "RS"));
  const sources = el("div", { class: "card" }, [el("h2", { text: t("s.sources") }),
    el("div", { class: "chips" }, mine.map((s) => track(el("label", { class: "chip" }, [
      el("input", { type: "checkbox", checked: st.sources_enabled[s.id] ?? s.default,
        onchange: (e) => { st.sources_enabled[s.id] = e.target.checked; markDirty(); } }),
      s.name, el("small", { text: `min. ${s.min_interval_hours}h` })]), (src) => src.sources_enabled[s.id] ?? s.default))),
    el("p", { class: "muted", text: t("s.sources_note") })]);
  renderProfileAndRules(general, searches, schedule, sources);
}

const range = (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => [String(lo + i), String(lo + i)]);

// "Fill in from my CV": the CV is read in this browser only (cvscan.js); the person sees what was found and applies it
function cvBlock() {
  const st = state.settings;
  const sug = state.cvSuggestion;
  const status = el("p", { class: "muted", text: t("cv.private") });
  const input = el("input", { type: "file", accept: ".pdf,.docx,.txt", class: "hidden", onchange: async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    status.textContent = t("cv.reading");
    try {
      const { fileText, scan } = await import("./cvscan.js?v=__V__");
      state.cvSuggestion = scan(await fileText(file), opt(), st.country || "RS");
      if (state.cvSuggestion.words < 30) throw new Error("empty");
    } catch (err) {
      state.cvSuggestion = null;
      status.textContent = t(err.message === "unsupported_file" ? "cv.unsupported" : err.message === "empty" ? "cv.empty" : "cv.failed");
      status.className = "error";
      return;
    }
    renderSearches();
  } });
  const pickBtn = el("button", { class: "ghost small", type: "button", text: t("cv.choose"), onclick: () => input.click() });
  const parts = [el("div", { class: "row" }, [el("strong", { text: t("cv.title") }), el("span", {}, [input, pickBtn])]), status];
  if (sug) {
    const fam = sug.field && family(sug.field.id);
    const pick = { field: Boolean(fam && !st.searches.some((s) => s.family === fam.id)), languages: true, skills: true, place: false }; // a city in a CV is often just where someone studied
    const line = (key, label, value) => value && el("label", { class: "inline" }, [
      el("input", { type: "checkbox", checked: pick[key], onchange: (e) => { pick[key] = e.target.checked; } }),
      el("span", {}, [el("strong", { text: `${label}: ` }), value])]);
    const levelName = (l) => t(`lvl.${l}`);
    parts.push(el("div", { class: "search" }, [
      el("div", { class: "group-title", text: t("cv.found") }),
      line("field", t("s.family"), fam && `${nameOf(fam)} · ${fam.specializations.filter((x) => sug.field.specializations.includes(x.id)).map(nameOf).join(", ")}` +
        (sug.seniority.length ? ` · ${sug.seniority.map((x) => opt().seniority.find((y) => y.id === x)?.name).join("/")} (${t("cv.years", { n: sug.years })})` : "")),
      line("languages", t("s.languages"), sug.languages.map((l) => `${l.name} (${levelName(l.level)})`).join(", ")),
      line("skills", t("s.skills"), sug.skills.map((x) => x.name).join(", ")),
      line("place", t("s.locations"), sug.cities.map((c) => country().cities.find((x) => x.id === c)?.name).join(", ")),
      !fam && el("p", { class: "muted", text: t("cv.no_field") }),
      el("div", { class: "row", style: "justify-content:flex-start" }, [
        el("button", { class: "small", text: t("cv.apply"), onclick: () => {
          if (pick.field && fam) {
            const s = newSearch();
            Object.assign(s, { family: fam.id, name: nameOf(fam), specializations: sug.field.specializations,
              seniority: sug.seniority.length ? sug.seniority : s.seniority, locations: ["remote", ...(pick.place ? sug.cities : [])] });
            st.searches.push(s);
          } else if (pick.place) {
            st.searches.forEach((s) => sug.cities.forEach((c) => { if (!s.locations.includes(c)) s.locations.push(c); }));
          }
          if (pick.languages) sug.languages.forEach((l) => { if (!st.profile.languages.some((k) => k.name === l.name)) st.profile.languages.push(l); });
          if (pick.skills) sug.skills.forEach((x) => { if (!st.profile.skills.some((k) => k.name === x.name)) st.profile.skills.push(x); });
          state.cvSuggestion = null;
          markDirty();
          renderSearches();
          paintSaveStatus(t("cv.applied"), "warn");
        } }),
        el("button", { class: "ghost small", text: t("cv.discard"), onclick: () => { state.cvSuggestion = null; renderSearches(); } }),
      ]),
    ]));
  }
  return el("div", { class: "search", style: "margin:0 0 14px" }, parts);
}

function renderProfileAndRules(...before) {
  const st = state.settings;
  const known = st.profile.languages;
  const levels = ["native", "advanced", "intermediate", "basic", "understood"];
  const langLabel = (name) => (lang() === "sr" ? opt().languages.find((l) => l.name === name)?.label : null) || name;
  const addLang = selectEl([["", t("s.pick_language")], ...opt().languages.filter((l) => !known.some((k) => k.name === l.name))
    .map((l) => [l.name, langLabel(l.name)]).sort((a, b) => a[1].localeCompare(b[1]))], "", () => {});
  const skillNames = [...new Set(st.searches.flatMap((s) => family(s.family).skills))].sort((a, b) => a.localeCompare(b));
  const level = (name) => st.profile.skills.find((s) => s.name === name)?.level || "";
  const profile = el("div", { class: "card" }, [
    el("h2", { text: t("s.profile") }),
    cvBlock(),
    el("div", { class: "group-title", text: t("s.languages") }),
    el("div", { class: "list" }, known.map((k, i) => track(el("div", { class: "item" }, [
      el("span", { class: "grow", text: langLabel(k.name) }),
      selectEl(levels.map((l) => [l, t(`lvl.${l}`)]), k.level, (v) => { k.level = v; markDirty(); }),
      el("button", { class: "danger small", text: t("s.remove"), onclick: () => { known.splice(i, 1); markDirty(); renderSearches(); } }),
    ]), (src) => src.profile.languages.find((l) => l.name === k.name)?.level))),
    el("div", { class: "row", style: "justify-content:flex-start;margin-top:8px" }, [addLang,
      el("button", { class: "ghost small", text: t("s.add_language"), onclick: () => {
        if (addLang.value) { known.push({ name: addLang.value, level: "intermediate" }); markDirty(); renderSearches(); }
      } })]),
    el("div", { class: "group-title", text: t("s.skills") }),
    el("div", { class: "grid" }, skillNames.map((name) => track(el("label", { class: "inline" }, [
      selectEl([["", "—"], ["basic", t("s.level.basic")], ["strong", t("s.level.strong")]], level(name), (v) => {
        st.profile.skills = st.profile.skills.filter((s) => s.name !== name);
        if (v) st.profile.skills.push({ name, level: v });
        markDirty();
      }), name]), (src) => src.profile.skills.find((x) => x.name === name)?.level || ""))),
    el("p", { class: "muted", text: t("s.skills_note") }),
  ]);
  const rules = el("div", { class: "card" }, [el("h2", { text: t("s.dealbreakers") }),
    ...DEALBREAKERS.map((k) => track(el("label", { class: "inline", style: "justify-content:space-between" }, [t(`db.${k}`),
      selectEl([["drop", t("s.drop")], ["warn", t("s.warn")]], st.dealbreakers[k] || "drop", (v) => { st.dealbreakers[k] = v; markDirty(); })]),
      (src) => src.dealbreakers[k] || "drop"))]);
  const tg = st.channels?.telegram?.chat_id;
  const notify = el("div", { class: "card" }, [el("h2", { text: t("n.title") }),
    el("p", {}, [el("strong", { text: `${t("n.telegram")}: ` }), tg ? t("n.telegram_on") : t("n.telegram_off")]),
    el("p", { class: "muted" }, [el("strong", { text: `${t("n.email")}: ` }), t("n.email_soon")])]);
  $("#tab-searches").replaceChildren(...before, profile, rules, notify);
  paintDiffs();
}

$("#save").addEventListener("click", async () => {
  const st = state.settings;
  const empty = st.searches.find((s) => !s.specializations.length || !s.seniority.length || !s.locations.length);
  if (empty) return paintSaveStatus(t("s.need_one", { name: empty.name }), "error");
  paintSaveStatus(t("saving"));
  try {
    const r = await api("PUT", "/api/me/settings", st);
    state.me.settings = r.settings;
    state.dirty = false;
    state.restored = false;
    clearDraft();
    paintDiffs();
    paintSaveStatus(t("saved"), "ok");
  } catch (e) {
    if (e.status === 401) return showLogin("start");
    paintSaveStatus(errText(e.code), "error");
  }
});

// ---------- onboarding ----------
function openOnboarding() {
  const st = state.settings;
  const s = newSearch();
  let step = 1;
  const box = $("#onboarding");
  const draw = () => {
    const f = family(s.family);
    const body = {
      1: [el("h2", { text: t("ob.where") }), el("div", { class: "grid" }, [
        el("label", {}, [t("language"), selectEl(LANGS.map((l) => [l, l === "sr" ? "Srpski" : "English"]), lang(), (v) => { changeLang(v); draw(); })]),
        el("label", {}, [t("country"), selectEl(opt().countries.map((c) => [c.code, c.name]), st.country || "RS", (v) => { st.country = v; s.locations = ["remote"]; draw(); })]),
      ])],
      2: [el("h2", { text: t("ob.what") }),
        el("label", {}, [t("s.family"), selectEl(opt().families.map((x) => [x.id, nameOf(x)]), s.family, (v) => {
          s.family = v; s.name = nameOf(family(v)); s.specializations = family(v).specializations.map((x) => x.id); draw(); })]),
        chipGroup(t("s.specializations"), f.specializations.map((x) => ({ id: x.id, label: nameOf(x) })), s.specializations, (id, on) => toggle(s.specializations, id, on)),
        chipGroup(t("s.seniority"), opt().seniority.map((x) => ({ id: x.id, label: x.name })), s.seniority, (id, on) => toggle(s.seniority, id, on)),
        placesBlock(s, draw)],
      3: [el("h2", { text: t("ob.how") }),
        el("p", {}, [el("strong", { text: `${t("n.telegram")}: ` }), st.channels?.telegram?.chat_id ? t("n.telegram_on") : t("n.telegram_off")]),
        el("p", { class: "muted" }, [el("strong", { text: `${t("n.email")}: ` }), t("n.email_soon")]),
        el("p", { text: t("ob.done") })],
    }[step];
    box.replaceChildren(el("div", { class: "wizard" }, [
      el("div", { class: "row" }, [el("h1", { text: t("ob.title") }), el("span", { class: "muted", text: t("ob.step", { n: step }) })]),
      ...body,
      el("p", { class: "error", id: "ob-error" }),
      el("div", { class: "actions" }, [
        step > 1 ? el("button", { class: "ghost", text: t("back"), onclick: () => { step--; draw(); } }) : el("span"),
        el("button", { text: step < 3 ? t("next") : t("finish"), onclick: async () => {
          if (step === 2 && (!s.specializations.length || !s.seniority.length || !s.locations.length)) {
            $("#ob-error").textContent = t("s.need_one", { name: s.name });
            return;
          }
          if (step < 3) { step++; draw(); return; }
          st.searches = [s];
          st.schedule = { interval_hours: 2, active_from: "08:00", active_to: "22:00" };
          st.notify_via = ["telegram"];
          try {
            state.me.settings = (await api("PUT", "/api/me/settings", st)).settings;
            state.dirty = false;
            clearDraft();
            box.classList.add("hidden");
            renderApp();
          } catch (e) { $("#ob-error").textContent = errText(e.code); }
        } }),
      ]),
    ]));
  };
  box.classList.remove("hidden");
  draw();
}

// ---------- applications ----------
async function renderApplications() {
  const root = $("#tab-applications");
  root.replaceChildren(el("div", { class: "card" }, [el("p", { class: "muted", text: t("loading") })]));
  try {
    state.apps = (await api("GET", "/api/applications")).applications;
  } catch (e) {
    if (e.status === 401) return showLogin("start");
    root.replaceChildren(el("div", { class: "card error", text: errText(e.code) }));
    return;
  }
  drawApplications();
}
function drawApplications(filter = state.appsFilter || "") {
  state.appsFilter = filter;
  const root = $("#tab-applications");
  const rows = state.apps.filter((a) => !filter || a.status === filter);
  const statusSelect = (a) => selectEl(STATUSES.map((s) => [s, t(`st.${s}`)]), a.status, async (v) => {
    try { Object.assign(a, (await api("PATCH", `/api/applications/${encodeURIComponent(a.id)}`, { status: v })).application); }
    catch (e) { alertRow(e); }
  }, { class: "status" });
  const noteCell = (a) => el("td", { class: "notes" }, [
    (a.notes || []).map((n) => n.text).join("\n"),
    el("input", { type: "text", placeholder: t("a.add_note"), onkeydown: async (e) => {
      if (e.key !== "Enter" || !e.target.value.trim()) return;
      try {
        Object.assign(a, (await api("PATCH", `/api/applications/${encodeURIComponent(a.id)}`, { note: e.target.value })).application);
        drawApplications(filter);
      } catch (err) { alertRow(err); }
    } }),
  ]);
  const head = ["a.date", "a.company", "a.title", "a.source", "a.score", "a.status", "a.deadline", "a.notes"].map((k) => el("th", { text: t(k) }));
  root.replaceChildren(el("div", { class: "card" }, [
    el("div", { class: "row" }, [el("h2", { text: t("tab.applications") }),
      selectEl([["", t("a.all")], ...STATUSES.map((s) => [s, t(`st.${s}`)])], filter, (v) => drawApplications(v))]),
    el("p", { class: "error", id: "apps-error" }),
    rows.length ? el("div", { class: "table-wrap" }, [el("table", {}, [el("thead", {}, [el("tr", {}, head)]),
      el("tbody", {}, rows.map((a) => el("tr", {}, [
        el("td", { text: (a.created_at || "").slice(0, 10) }), el("td", { text: a.company || "" }),
        el("td", {}, [el("a", { href: a.url, target: "_blank", rel: "noopener noreferrer", text: a.title || "—" })]),
        el("td", { text: a.source || "" }), el("td", { text: a.score ? `${a.score}/10` : "" }),
        el("td", {}, [statusSelect(a)]), el("td", { text: a.deadline || "" }), noteCell(a),
      ])))])]) : el("p", { class: "muted", text: t("a.empty") }),
  ]));
}
function alertRow(e) {
  if (e.status === 401) return showLogin("start");
  $("#apps-error").textContent = errText(e.code);
}

// taps in Telegram change statuses on the site at once; an open Applications tab asks whether anything changed
// (a tiny request) and loads the list only when it did. It asks every 3 seconds while the person is active on the
// page, slowing down to 30 seconds while the page just sits there: each question counts against Cloudflare's
// free 100,000 API requests a day. (With many users, a WebSocket push replaces this – see docs/PLAN.md.)
const FAST_MS = 3000, SLOW_MS = 30000, ACTIVE_FOR_MS = 120000;
let appsVersion = "", lastActive = Date.now(), lastAsked = 0;
["pointermove", "keydown", "scroll", "touchstart", "focus"].forEach((ev) =>
  window.addEventListener(ev, () => { lastActive = Date.now(); }, { passive: true }));
async function refreshApplications(force = false) {
  if (state.tab !== "applications" || document.visibilityState !== "visible" || !state.me) return;
  if (document.activeElement?.closest?.("#tab-applications")) return; // someone is typing a note or picking a status
  const every = Date.now() - lastActive < ACTIVE_FOR_MS ? FAST_MS : SLOW_MS;
  if (!force && Date.now() - lastAsked < every) return;
  lastAsked = Date.now();
  try {
    const { version } = await api("GET", "/api/applications/version");
    if (version === appsVersion) return;
    const fresh = (await api("GET", "/api/applications")).applications;
    appsVersion = version;
    if (JSON.stringify(fresh) !== JSON.stringify(state.apps)) { state.apps = fresh; drawApplications(); }
  } catch { /* offline or signed out: the next round or a click will tell */ }
}
setInterval(refreshApplications, 1000);
document.addEventListener("visibilitychange", () => { lastActive = Date.now(); refreshApplications(true); });

// ---------- account ----------
function renderAccount() {
  const me = state.me;
  $("#tab-account").replaceChildren(el("div", { class: "card" }, [
    el("label", {}, [t("acc.name"), el("input", { type: "text", value: state.settings.name || "", oninput: (e) => {
      state.settings.name = e.target.value; markDirty(); $("#savebar").classList.remove("hidden");
    } })]),
    el("p", { class: "muted", text: `${t("acc.member_since")}: ${(me.created_at || "").slice(0, 10)}` }),
    el("h2", { text: t("acc.signins") }),
    el("div", { class: "list" }, me.identities.map((i) => el("div", { class: "item" }, [
      el("strong", { text: i.provider === "telegram" ? "Telegram" : i.provider }), el("span", { class: "grow", text: i.label }),
      el("span", { class: "muted", text: (i.created_at || "").slice(0, 10) })]))),
    el("p", { class: "muted", text: t("acc.more_soon") }),
  ]));
}

// ---------- admin ----------
async function renderAdmin() {
  const root = $("#tab-admin");
  root.replaceChildren(el("div", { class: "card muted", text: t("loading") }));
  let settings, users, invites;
  try {
    [settings, { users }, { invites }] = await Promise.all([api("GET", "/api/admin/settings"), api("GET", "/api/admin/users"), api("GET", "/api/admin/invites")]);
  } catch (e) {
    root.replaceChildren(el("div", { class: "card error", text: errText(e.code) }));
    return;
  }
  const status = el("p", { role: "status" });
  const saveSetting = async (body) => {
    try { await api("PUT", "/api/admin/settings", body); status.textContent = t("saved"); status.className = "ok"; }
    catch (e) { status.textContent = errText(e.code); status.className = "error"; }
  };
  const copy = async (text, btn) => {
    try { await navigator.clipboard.writeText(text); btn.textContent = t("ad.copied"); } catch { prompt("", text); }
  };
  const note = el("input", { type: "text", placeholder: t("ad.note") });
  const runStatus = el("div", { role: "status", class: "run-status" });
  const start = async (full) => {
    runBtn.disabled = fullBtn.disabled = true;
    try {
      const r = await api("POST", "/api/admin/run", { full });
      if (!r.started) { runStatus.replaceChildren(t("ad.run_busy")); runStatus.className = "run-status warn"; }
    } catch (e) { runStatus.replaceChildren(errText(e.code)); runStatus.className = "run-status error"; }
    followRun(runStatus, [runBtn, fullBtn]);
  };
  const runBtn = el("button", { text: t("ad.run_now"), onclick: () => start(false) });
  const fullBtn = el("button", { class: "ghost", text: t("ad.run_full"), onclick: () => start(true) });
  followRun(runStatus, [runBtn, fullBtn]);
  root.replaceChildren(
    el("div", { class: "card" }, [el("div", { class: "row" }, [el("h2", { text: t("ad.search") }), el("div", { class: "row" }, [fullBtn, runBtn])]),
      el("p", { class: "muted", text: t("ad.run_note") }), el("p", { class: "muted", text: t("ad.full_note") }), runStatus]),
    el("div", { class: "card" }, [
      el("div", { class: "grid two" }, [
        el("label", {}, [t("ad.registration"), selectEl([["invite_only", t("ad.invite_only")], ["open", t("ad.open")]], settings.registration,
          (v) => saveSetting({ registration: v }))]),
        el("label", {}, [t("ad.cv"), selectEl([["manual", t("ad.cv.manual")], ["claude_api", t("ad.cv.claude_api")]], settings.cv_generator,
          (v) => saveSetting({ cv_generator: v }))]),
        el("label", {}, [t("ad.cap"), selectEl(dollars([0, 1, 2, 5, 10, 20, 50, 100], settings.api_monthly_cap_usd),
          String(settings.api_monthly_cap_usd), (v) => saveSetting({ api_monthly_cap_usd: Number(v) }))]),
        el("label", {}, [t("ad.user_cap"), selectEl(dollars([0, 0.5, 1, 2, 5, 10], settings.api_user_monthly_cap_usd),
          String(settings.api_user_monthly_cap_usd), (v) => saveSetting({ api_user_monthly_cap_usd: Number(v) }))]),
      ]),
      status,
    ]),
    el("div", { class: "card" }, [
      el("div", { class: "row" }, [el("h2", { text: t("ad.invites") }), el("div", { class: "row" }, [note,
        el("button", { class: "ghost small", text: t("ad.new_invite"), onclick: async () => {
          await api("POST", "/api/admin/invites", { note: note.value }); renderAdmin();
        } })])]),
      el("div", { class: "list" }, invites.map((i) => {
        const link = `${location.origin}/?invite=${i.code}`;
        return el("div", { class: "item" }, [
          el("span", { class: "grow" }, [el("strong", { text: i.note || "—" }), " ", el("span", { class: "muted", text: i.used_by ? t("ad.used") : t("ad.unused") })]),
          !i.used_by && el("button", { class: "ghost small", text: t("ad.copy"), onclick: (e) => copy(link, e.target) }),
          !i.used_by && el("button", { class: "danger small", text: t("ad.delete"), onclick: async () => {
            await api("DELETE", `/api/admin/invites/${encodeURIComponent(i.code)}`); renderAdmin();
          } }),
        ]);
      })),
    ]),
    el("div", { class: "card" }, [el("h2", { text: t("ad.users") }),
      el("div", { class: "list" }, users.map((u) => {
        const self = u.id === state.me.id;
        return el("div", { class: "item" }, [
          el("span", { class: "grow" }, [el("strong", { text: u.name || (u.identities || "").replace(/^telegram:/, "") || u.id.slice(0, 8) }), " ",
            el("span", { class: "muted", text: [u.name ? u.identities : "", u.role === "admin" ? "admin" : "", self ? t("ad.you") : "",
              u.active ? "" : t("ad.disabled")].filter(Boolean).join(" · ") })]),
          !self && el("button", { class: "ghost small", text: u.role === "admin" ? t("ad.make_user") : t("ad.make_admin"), onclick: async () => {
            await api("PATCH", `/api/admin/users/${u.id}`, { role: u.role === "admin" ? "user" : "admin" }); renderAdmin();
          } }),
          !self && el("button", { class: u.active ? "danger small" : "ghost small", text: u.active ? t("ad.disable") : t("ad.enable"), onclick: async () => {
            await api("PATCH", `/api/admin/users/${u.id}`, { active: !u.active }); renderAdmin();
          } }),
        ]);
      }))]),
  );
}

// dollar amounts for a dropdown, keeping a saved amount that isn't in the list
const dollars = (list, current) => [...new Set([...list, Number(current)])].sort((a, b) => a - b).map((n) => [String(n), `$${n}`]);

// ---------- the latest search ----------
// queued → running → done, shown with a turning hourglass while it lasts; checked every 5 seconds until it ends
const STALE_MIN = 40;
let runTimer = 0;
const minutesSince = (iso) => Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
const clock = (iso) => new Date(iso).toLocaleTimeString(lang() === "sr" ? "sr-Latn-RS" : "en-GB", { hour: "2-digit", minute: "2-digit" });
async function followRun(box, buttons) {
  clearTimeout(runTimer);
  let run;
  try { run = await api("GET", "/api/admin/run"); } catch { return; }
  if (!box.isConnected) return; // the admin tab was left
  const since = run.started_at || run.requested_at;
  const busy = ["queued", "running"].includes(run.state) && since && minutesSince(since) < STALE_MIN;
  buttons.forEach((b) => { b.disabled = busy; });
  if (busy) {
    const text = (run.full ? `${t("ad.full")} – ` : "") + (run.state === "queued" ? t("ad.run_queued") : t("ad.run_running", { n: minutesSince(since) }));
    box.replaceChildren(el("span", { class: "hourglass", "aria-hidden": "true", text: "⏳" }), " ", text);
    box.className = "run-status";
    runTimer = setTimeout(() => followRun(box, buttons), 5000);
  } else if (run.state === "done") {
    const took = Math.max(1, Math.round((new Date(run.finished_at) - new Date(run.started_at)) / 60000));
    box.replaceChildren((run.full ? `${t("ad.full")} – ` : "") +
      t("ad.run_done", { at: clock(run.finished_at), min: took, new: run.new ?? 0, sent: run.sent ?? 0, users: run.users ?? 0 }));
    box.className = "run-status ok";
  } else if (run.state) {
    box.replaceChildren(t("ad.run_stale"));
    box.className = "run-status warn";
  }
}

// ---------- version ----------
// "202611060230" → "v 06.11.2026 02:30" in the corner; a newer version.json reloads the page on the same tab and
// scroll position (unsaved edits survive as a draft, see markDirty)
const VERSION = "__V__";
function showVersion() {
  const m = VERSION.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})\d*$/);
  $("#version").textContent = m ? `v ${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]}` : `v ${VERSION}`;
}
async function checkVersion() {
  if (document.visibilityState !== "visible" || !/^\d+$/.test(VERSION)) return;
  try {
    const { version } = await (await fetch(`version.json?t=${Date.now()}`, { cache: "no-store" })).json();
    if (!version || version === VERSION) return;
    saveView();
    location.replace(`${location.pathname}?v=${version}${invite ? `&invite=${invite}` : ""}`);
  } catch { /* offline: try again later */ }
}
// the tab and scroll position survive any reload (a refresh, or a new version loading itself)
function saveView() {
  try { sessionStorage.setItem("view", JSON.stringify({ tab: state.tab, scroll: scrollY })); } catch { /* no memory: first tab */ }
}
window.addEventListener("pagehide", saveView);
function restoreView() {
  try {
    const view = JSON.parse(sessionStorage.getItem("view") || "null");
    if (view?.tab) state.tab = view.tab;
    return view?.scroll || 0;
  } catch { return 0; }
}

// ---------- start ----------
(async () => {
  setLang(store.get("lang") || ((navigator.language || "en").startsWith("sr") ? "sr" : "en"));
  const [brand, options] = await Promise.all([fetch("brand.json").then((r) => r.json()).catch(() => ({})),
    fetch("options.json").then((r) => r.json())]);
  Object.assign(state, { brand, options });
  showVersion();
  const scroll = restoreView();
  paintStatic();
  await boot();
  requestAnimationFrame(() => scrollTo(0, scroll));
  setInterval(checkVersion, 30000);
  document.addEventListener("visibilitychange", checkVersion);
})();
