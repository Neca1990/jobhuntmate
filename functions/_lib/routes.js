// Every API route. functions/api/[[route]].js hands requests here; tests call handle() directly.
import * as auth from "./auth/index.js";
import { PROVIDERS } from "./auth/index.js";
import { cardAction, relabel } from "./cards.js";
import { isDue } from "./schedule.js";
import { endSession, requireUser } from "./session.js";
import { HttpError, json, nowIso, parse, readBody, sameSecret } from "./util.js";

const SETTINGS_KEYS = ["name", "language", "country", "notify_via", "channels", "searches", "schedule", "sources_enabled",
  "max_messages_per_run", "max_age_days", "dealbreakers", "profile"];
const ADMIN_SETTINGS = {
  registration: (v) => ["invite_only", "open"].includes(v),
  cv_generator: (v) => ["manual", "claude_api"].includes(v),
  api_monthly_cap_usd: (v) => typeof v === "number" && v >= 0 && v <= 1000,
  api_user_monthly_cap_usd: (v) => typeof v === "number" && v >= 0 && v <= 1000,
  login_providers: (v) => Array.isArray(v) && v.length > 0 && v.every((p) => p in PROVIDERS),
};
const ENGINE_FILES = ["state", "seen", "queue"];

function route(method, pattern) {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  return { method, re, keys };
}

const ROUTES = [];
const on = (method, pattern, fn) => ROUTES.push({ ...route(method, pattern), fn });

export async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  for (const r of ROUTES) {
    const m = r.method === request.method && path.match(r.re);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    try {
      return await r.fn({ request, env, db: env.DB, params, url });
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code }, e.status);
      console.log(`api error ${request.method} ${path}: ${e?.message}`); // no request data in logs
      return json({ error: "server_error" }, 500);
    }
  }
  return json({ error: "not_found" }, 404);
}

// ---------- signing in ----------
on("GET", "/api/auth/providers", async ({ db }) => json({ providers: await auth.enabledProviders(db) }));

on("POST", "/api/auth/:provider/start", async ({ request, env, db, params }) => {
  const body = await readBody(request);
  return json(await auth.start(env, db, params.provider, { invite: body.invite || "", username: body.username || "" }));
});

on("POST", "/api/auth/poll", async ({ request, env, db }) => {
  const body = await readBody(request);
  const r = await auth.poll(env, db, body.token);
  if (r.pending) return json({ pending: true });
  return json({ ok: true, role: r.user.role }, 200, { "set-cookie": r.cookie });
});

on("POST", "/api/auth/verify", async ({ request, env, db }) => {
  const body = await readBody(request);
  const { user, cookie } = await auth.verify(env, db, body.token, body.code);
  return json({ ok: true, role: user.role }, 200, { "set-cookie": cookie });
});

on("POST", "/api/auth/logout", async ({ request, db }) => json({ ok: true }, 200, { "set-cookie": await endSession(request, db) }));

// the bot's webhook: Telegram sends the secret we gave it in setWebhook
on("POST", "/api/telegram", async ({ request, env, db }) => {
  if (!sameSecret(request.headers.get("x-telegram-bot-api-secret-token") || "", env.TELEGRAM_WEBHOOK_SECRET || "-")) {
    throw new HttpError(403, "forbidden");
  }
  const update = await readBody(request);
  const msg = update.message;
  const start = msg?.text?.match(/^\/start\s+([A-Za-z0-9_-]{20,64})$/);
  if (start && msg.chat?.type === "private") {
    await PROVIDERS.telegram.onStart(env, db, msg, start[1], auth.reach);
  }
  const query = update.callback_query;
  if (query?.data?.startsWith("l:")) await PROVIDERS.telegram.onButton(env, db, query, auth.approve);
  else if (query) await cardAction(env, db, query);
  return json({ ok: true });
});

// ---------- the signed-in user ----------
on("GET", "/api/me", async ({ request, db }) => {
  const user = await requireUser(request, db);
  const ids = await db.prepare("SELECT provider, label, created_at FROM identities WHERE user_id = ?").bind(user.id).all();
  return json({ id: user.id, role: user.role, created_at: user.created_at, settings: user.settings, identities: ids.results });
});

on("PUT", "/api/me/settings", async ({ request, db }) => {
  const user = await requireUser(request, db);
  const body = await readBody(request);
  const next = { ...user.settings };
  for (const k of SETTINGS_KEYS) if (k in body) next[k] = body[k];
  next.channels = user.settings.channels || {}; // connected chats change only through their own flows
  await db.prepare("UPDATE users SET settings = ? WHERE id = ?").bind(JSON.stringify(next), user.id).run();
  return json({ settings: next });
});

on("GET", "/api/applications", async ({ request, db }) => {
  const user = await requireUser(request, db);
  const rows = await db.prepare("SELECT data FROM applications WHERE user_id = ? ORDER BY updated_at DESC").bind(user.id).all();
  return json({ applications: rows.results.map((r) => parse(r.data, {})) });
});

// a tiny "did anything change?" for the open Applications tab: the latest change time and the count
on("GET", "/api/applications/version", async ({ request, db }) => {
  const user = await requireUser(request, db);
  const row = await db.prepare("SELECT MAX(updated_at) AS v, COUNT(*) AS n FROM applications WHERE user_id = ?").bind(user.id).first();
  return json({ version: `${row?.v || ""}#${row?.n || 0}` });
});

on("PATCH", "/api/applications/:id", async ({ request, env, db, params }) => {
  const user = await requireUser(request, db);
  const body = await readBody(request);
  const row = await db.prepare("SELECT data FROM applications WHERE user_id = ? AND id = ?").bind(user.id, params.id).first();
  if (!row) throw new HttpError(404, "not_found");
  const app = parse(row.data, {});
  const before = app.status;
  if (typeof body.status === "string") app.status = body.status.slice(0, 40);
  if (typeof body.note === "string" && body.note.trim()) {
    app.notes = [...(app.notes || []), { at: nowIso(), text: body.note.trim().slice(0, 2000) }];
  }
  await db.prepare("UPDATE applications SET data = ?, updated_at = ? WHERE user_id = ? AND id = ?")
    .bind(JSON.stringify(app), nowIso(), user.id, params.id).run();
  if (app.status !== before) await relabel(env, app, user.settings.language);
  return json({ application: app });
});

// ---------- admin ----------
async function requireAdmin(request, db) {
  const user = await requireUser(request, db);
  if (user.role !== "admin") throw new HttpError(403, "admin_only");
  return user;
}

on("GET", "/api/admin/settings", async ({ request, db }) => {
  await requireAdmin(request, db);
  const rows = await db.prepare("SELECT key, value FROM app_settings").all();
  return json(Object.fromEntries(rows.results.map((r) => [r.key, parse(r.value, null)])));
});

on("PUT", "/api/admin/settings", async ({ request, db }) => {
  await requireAdmin(request, db);
  const body = await readBody(request);
  for (const [k, v] of Object.entries(body)) {
    if (!ADMIN_SETTINGS[k]?.(v)) throw new HttpError(400, `bad_setting:${k}`);
  }
  await db.batch(Object.entries(body).map(([k, v]) =>
    db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(k, JSON.stringify(v))));
  return json({ ok: true });
});

on("GET", "/api/admin/users", async ({ request, db }) => {
  await requireAdmin(request, db);
  const rows = await db.prepare(
    "SELECT u.id, u.role, u.active, u.created_at, json_extract(u.settings, '$.name') AS name, " +
    "(SELECT group_concat(provider || ':' || label, ', ') FROM identities i WHERE i.user_id = u.id) AS identities " +
    "FROM users u ORDER BY u.created_at").all();
  return json({ users: rows.results });
});

on("PATCH", "/api/admin/users/:id", async ({ request, db, params }) => {
  const admin = await requireAdmin(request, db);
  const body = await readBody(request);
  if (params.id === admin.id && (body.active === false || body.role === "user")) throw new HttpError(400, "cannot_demote_self");
  if ("active" in body) await db.prepare("UPDATE users SET active = ? WHERE id = ?").bind(body.active ? 1 : 0, params.id).run();
  if (["user", "admin"].includes(body.role)) await db.prepare("UPDATE users SET role = ? WHERE id = ?").bind(body.role, params.id).run();
  if (body.active === false) await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(params.id).run();
  return json({ ok: true });
});

on("POST", "/api/admin/invites", async ({ request, db, url }) => {
  const admin = await requireAdmin(request, db);
  const body = await readBody(request);
  const code = auth.newInviteCode();
  await db.prepare("INSERT INTO invites (code, created_by, created_at, note) VALUES (?, ?, ?, ?)")
    .bind(code, admin.id, nowIso(), String(body.note || "").slice(0, 200)).run();
  return json({ code, link: `${url.origin}/?invite=${code}` });
});

on("GET", "/api/admin/invites", async ({ request, db }) => {
  await requireAdmin(request, db);
  const rows = await db.prepare("SELECT code, note, created_at, used_by, used_at FROM invites ORDER BY created_at DESC").all();
  return json({ invites: rows.results });
});

on("DELETE", "/api/admin/invites/:code", async ({ request, db, params }) => {
  await requireAdmin(request, db);
  await db.prepare("DELETE FROM invites WHERE code = ? AND used_by = ''").bind(params.code).run();
  return json({ ok: true });
});

// ---------- the search engine (GitHub Actions), with its own key ----------
function requireEngine(request, env) {
  const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!env.ENGINE_KEY || !sameSecret(given, env.ENGINE_KEY)) throw new HttpError(403, "forbidden");
}

on("GET", "/api/engine/users", async ({ request, env, db }) => {
  requireEngine(request, env);
  const rows = await db.prepare("SELECT id, settings FROM users WHERE active = 1").all();
  return json({ users: rows.results.map((r) => ({ ...parse(r.settings, {}), id: r.id })) });
});

on("GET", "/api/engine/users/:id/:name", async ({ request, env, db, params }) => {
  requireEngine(request, env);
  if (params.name === "applications") {
    const rows = await db.prepare("SELECT data FROM applications WHERE user_id = ?").bind(params.id).all();
    return json(rows.results.map((r) => parse(r.data, {})));
  }
  if (!ENGINE_FILES.includes(params.name)) throw new HttpError(404, "not_found");
  const row = await db.prepare("SELECT data FROM user_files WHERE user_id = ? AND name = ?").bind(params.id, params.name).first();
  return json(row ? parse(row.data, null) : null);
});

on("PUT", "/api/engine/users/:id/:name", async ({ request, env, db, params }) => {
  requireEngine(request, env);
  const data = await readBody(request, 5 * 1024 * 1024);
  const now = nowIso();
  if (params.name === "applications") {
    // the engine adds postings; statuses the user changed meanwhile on the site win for existing ones
    const have = new Set((await db.prepare("SELECT id FROM applications WHERE user_id = ?").bind(params.id).all())
      .results.map((r) => r.id));
    const fresh = (Array.isArray(data) ? data : []).filter((a) => a?.id && !have.has(a.id));
    if (fresh.length) {
      await db.batch(fresh.map((a) => db.prepare("INSERT INTO applications (user_id, id, data, updated_at) VALUES (?, ?, ?, ?)")
        .bind(params.id, a.id, JSON.stringify(a), now)));
    }
    return json({ added: fresh.length });
  }
  if (!ENGINE_FILES.includes(params.name)) throw new HttpError(404, "not_found");
  await db.prepare("INSERT INTO user_files (user_id, name, data, updated_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(user_id, name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
    .bind(params.id, params.name, JSON.stringify(data), now).run();
  return json({ ok: true });
});

on("GET", "/api/engine/global", async ({ request, env, db }) => {
  requireEngine(request, env);
  const row = await db.prepare("SELECT value FROM global_state WHERE key = 'state'").first();
  return json(row ? parse(row.value, {}) : {});
});

on("PUT", "/api/engine/global", async ({ request, env, db }) => {
  requireEngine(request, env);
  const data = await readBody(request, 2 * 1024 * 1024);
  await db.prepare("INSERT INTO global_state (key, value) VALUES ('state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(data)).run();
  return json({ ok: true });
});

on("PUT", "/api/engine/postings/:id", async ({ request, env, db, params }) => {
  requireEngine(request, env);
  const data = await readBody(request, 512 * 1024);
  await db.prepare("INSERT INTO postings (id, data, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING")
    .bind(params.id, JSON.stringify(data), nowIso()).run();
  return json({ ok: true });
});

on("GET", "/api/engine/companies", async ({ request, env, db }) => {
  requireEngine(request, env);
  const row = await db.prepare("SELECT value FROM global_state WHERE key = 'companies'").first();
  return json(row ? parse(row.value, null) : null);
});

on("PUT", "/api/engine/companies", async ({ request, env, db }) => {
  requireEngine(request, env);
  const data = await readBody(request, 2 * 1024 * 1024);
  await db.prepare("INSERT INTO global_state (key, value) VALUES ('companies', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(data)).run();
  return json({ ok: true });
});

// asked by the scheduler every few minutes: should the search run now?
on("GET", "/api/engine/due", async ({ request, env, db }) => {
  requireEngine(request, env);
  const users = (await db.prepare("SELECT settings FROM users WHERE active = 1").all()).results.map((r) => parse(r.settings, {}));
  const state = parse((await db.prepare("SELECT value FROM global_state WHERE key = 'state'").first())?.value, {});
  return json(isDue(users, state.last_run, new Date()));
});

// the job sites, only for signed-in users (the search keeps the list up to date)
on("GET", "/api/sources", async ({ request, db }) => {
  await requireUser(request, db);
  const row = await db.prepare("SELECT value FROM global_state WHERE key = 'sources'").first();
  return json({ sources: row ? parse(row.value, []) : [] });
});

on("PUT", "/api/engine/sources", async ({ request, env, db }) => {
  requireEngine(request, env);
  const list = await readBody(request);
  await db.prepare("INSERT INTO global_state (key, value) VALUES ('sources', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(Array.isArray(list) ? list : [])).run();
  return json({ ok: true });
});

// "search now" from the admin page: the scheduler starts the search on GitHub, even outside active hours
on("POST", "/api/admin/run", async ({ request, env, db }) => {
  await requireAdmin(request, db);
  if (!env.SCHEDULER) throw new HttpError(503, "scheduler_missing");
  const body = await readBody(request);
  const r = await env.SCHEDULER.fetch("https://scheduler/run", { method: "POST",
    headers: { authorization: `Bearer ${env.ENGINE_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ full: Boolean(body.full) }) });
  const result = await r.json();
  if (result.started) await saveRun(db, { state: "queued", requested_at: nowIso(), full: Boolean(body.full) });
  return json(result, r.ok ? 200 : 502);
});

async function saveRun(db, run) {
  await db.prepare("INSERT INTO global_state (key, value) VALUES ('run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(JSON.stringify(run)).run();
}

// where the latest search stands: queued (asked for), running, done
on("GET", "/api/admin/run", async ({ request, db }) => {
  await requireAdmin(request, db);
  const row = await db.prepare("SELECT value FROM global_state WHERE key = 'run'").first();
  return json(row ? parse(row.value, {}) : {});
});

on("PUT", "/api/engine/run", async ({ request, env, db }) => {
  requireEngine(request, env);
  await saveRun(db, await readBody(request));
  return json({ ok: true });
});
