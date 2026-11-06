// The posting archive and "search everything for me".
// The search keeps every posting it finds in the archive (pool) for pool_days; a person can ask for all of it to be
// matched against their settings, a few times a day (admin settings), and gets the best few at once.
// A safety keeps the free database limit far away: above pool_alert_mb, and again every pool_step_mb more, the
// period shortens and the admin gets a Telegram message.
import { notifyAdmin } from "./admin_chat.js";
import { HttpError, json, nowIso, parse, readBody } from "./util.js";

const DEFAULTS = { search_all_cooldown_min: 15, search_all_per_day: 3, search_all_send: 15, pool_days: 45, pool_alert_mb: 350, pool_step_mb: 50 };
export const POOL_SETTINGS = {
  search_all_cooldown_min: (v) => Number.isInteger(v) && v >= 0 && v <= 1440,
  search_all_per_day: (v) => Number.isInteger(v) && v >= 0 && v <= 100,
  search_all_send: (v) => Number.isInteger(v) && v >= 1 && v <= 50,
  pool_days: (v) => Number.isInteger(v) && v >= 3 && v <= 120,
  pool_alert_mb: (v) => Number.isInteger(v) && v >= 50 && v <= 480,
  pool_step_mb: (v) => Number.isInteger(v) && v >= 10 && v <= 200,
};
const SHORTER = [30, 21, 14, 7]; // the period after the 1st, 2nd, 3rd, 4th+ step of the safety
const MB = 1024 * 1024;

async function settings(db) {
  const rows = (await db.prepare("SELECT key, value FROM app_settings WHERE key IN (" +
    Object.keys(DEFAULTS).map(() => "?").join(",") + ")").bind(...Object.keys(DEFAULTS)).all()).results;
  return { ...DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.key, parse(r.value, null)]).filter(([, v]) => v !== null)) };
}
const setSetting = (db, key, value) => db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) " +
  "ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, JSON.stringify(value)).run();
const getState = async (db, key) => parse((await db.prepare("SELECT value FROM global_state WHERE key = ?").bind(key).first())?.value, {});
const setState = (db, key, value) => db.prepare("INSERT INTO global_state (key, value) VALUES (?, ?) " +
  "ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, JSON.stringify(value)).run();

// where a person stands: may they ask now, and if not, why
function standing(row, s, now) {
  const today = now.toISOString().slice(0, 10);
  const count = row?.day === today ? row.count : 0;
  const next = row?.last_at ? new Date(new Date(row.last_at).getTime() + s.search_all_cooldown_min * 60000) : null;
  const busy = ["waiting", "running"].includes(row?.state);
  const why = busy ? "busy" : count >= s.search_all_per_day ? "limit_day" : next && next > now ? "cooldown" : "";
  return { state: row?.state || "idle", count_today: count, per_day: s.search_all_per_day, cooldown_min: s.search_all_cooldown_min,
    send: s.search_all_send, days: s.pool_days, next_at: why === "cooldown" ? next.toISOString() : "", blocked: why,
    last_at: row?.last_at || "", result: parse(row?.result, {}) };
}

export function routes(on, { requireUser, requireEngine, requireAdmin }) {
  // ---- the person's side ----
  on("GET", "/api/search-all", async ({ request, db }) => {
    const user = await requireUser(request, db);
    const row = await db.prepare("SELECT * FROM search_all WHERE user_id = ?").bind(user.id).first();
    return json(standing(row, await settings(db), new Date()));
  });

  on("POST", "/api/search-all", async ({ request, env, db }) => {
    const user = await requireUser(request, db);
    if (!(user.settings?.searches || []).length) throw new HttpError(400, "no_searches");
    const s = await settings(db);
    const now = new Date();
    const row = await db.prepare("SELECT * FROM search_all WHERE user_id = ?").bind(user.id).first();
    const before = standing(row, s, now);
    if (before.blocked) throw new HttpError(429, before.blocked);
    const today = now.toISOString().slice(0, 10);
    await db.prepare("INSERT INTO search_all (user_id, state, day, count, last_at, result) VALUES (?, 'waiting', ?, ?, ?, '{}') " +
      "ON CONFLICT(user_id) DO UPDATE SET state = 'waiting', day = excluded.day, count = excluded.count, last_at = excluded.last_at, result = '{}'")
      .bind(user.id, today, before.count_today + 1, now.toISOString()).run();
    // start it right away; when a search is already running, that one (or the next) picks the request up
    if (env.SCHEDULER && env.ENGINE_KEY) {
      await env.SCHEDULER.fetch("https://scheduler/run", { method: "POST", headers: { authorization: `Bearer ${env.ENGINE_KEY}` },
        body: JSON.stringify({ search_all: true }) }).catch(() => {});
    }
    const after = await db.prepare("SELECT * FROM search_all WHERE user_id = ?").bind(user.id).first();
    return json(standing(after, s, now));
  });

  // ---- the search's side ----
  // which of these postings the archive doesn't have yet (so only new ones are sent and written)
  on("POST", "/api/engine/pool/known", async ({ request, env, db }) => {
    requireEngine(request, env);
    const ids = [...new Set(((await readBody(request, 2 * MB)).ids || []).map(String))].slice(0, 20000);
    const have = new Set();
    for (let i = 0; i < ids.length; i += 90) {
      const part = ids.slice(i, i + 90);
      const rows = (await db.prepare(`SELECT id FROM pool WHERE id IN (${part.map(() => "?").join(",")})`).bind(...part).all()).results;
      rows.forEach((r) => have.add(r.id));
    }
    return json({ missing: ids.filter((id) => !have.has(id)) });
  });

  on("PUT", "/api/engine/pool", async ({ request, env, db }) => {
    requireEngine(request, env);
    const list = (await readBody(request, 8 * MB)) || [];
    const now = nowIso();
    const rows = (Array.isArray(list) ? list : []).filter((p) => p?.id && p.source).slice(0, 500);
    if (rows.length) {
      await db.batch(rows.map((p) => db.prepare("INSERT OR IGNORE INTO pool (id, source, first_seen, data) VALUES (?, ?, ?, ?)")
        .bind(String(p.id), String(p.source), now, JSON.stringify(p))));
    }
    return json({ added: rows.length });
  });

  // the archive, a page at a time (by id), within the kept period
  on("GET", "/api/engine/pool", async ({ request, env, db }) => {
    requireEngine(request, env);
    const url = new URL(request.url);
    const after = url.searchParams.get("after") || "";
    const limit = Math.min(Number(url.searchParams.get("limit")) || 500, 1000);
    const since = new Date(Date.now() - (await settings(db)).pool_days * 86400000).toISOString();
    const rows = (await db.prepare("SELECT id, data FROM pool WHERE id > ? AND first_seen >= ? ORDER BY id LIMIT ?")
      .bind(after, since, limit).all()).results;
    return json({ postings: rows.map((r) => parse(r.data, null)).filter(Boolean), next: rows.length === limit ? rows.at(-1).id : "" });
  });

  // after each search: drop what's older than the period, measure, and apply the safety
  on("POST", "/api/engine/pool/cleanup", async ({ request, env, db }) => {
    requireEngine(request, env);
    const s = await settings(db);
    const old = await getState(db, "pool");
    const drop = async (days) => db.prepare("DELETE FROM pool WHERE first_seen < ?")
      .bind(new Date(Date.now() - days * 86400000).toISOString()).run();
    let r = await drop(s.pool_days);
    let deleted = r.meta?.changes || 0;
    let size = r.meta?.size_after || 0;
    let days = s.pool_days;
    // level 0 below the alert; 1 from pool_alert_mb, 2 from pool_alert_mb + pool_step_mb, and so on
    const level = size >= s.pool_alert_mb * MB ? 1 + Math.floor((size - s.pool_alert_mb * MB) / (s.pool_step_mb * MB)) : 0;
    const passed = level > (old.level || 0);
    if (passed) {
      days = Math.min(days, SHORTER[Math.min(level, SHORTER.length) - 1]);
      if (days < s.pool_days) {
        await setSetting(db, "pool_days", days);
        r = await drop(days);
        deleted += r.meta?.changes || 0;
        size = r.meta?.size_after || size;
      }
      {
        const mb = Math.round(size / MB);
        await notifyAdmin(env, db, `⚠️ Arhiva oglasa: baza je ${mb} MB (granica ${s.pool_alert_mb + (level - 1) * s.pool_step_mb} MB). ` +
          `Čuvam oglase ${days} dana umesto ${s.pool_days}. Podešava se na Admin stranici.`).catch(() => {});
      }
    }
    const rows = (await db.prepare("SELECT COUNT(*) AS n FROM pool").first())?.n || 0;
    const state = { size_mb: Math.round((size / MB) * 10) / 10, rows, days, deleted, at: nowIso(),
      level, // falls back when the database gets smaller, so the safety can warn again later
      ...(passed ? { shortened_at: nowIso(), shortened_from: s.pool_days } : { shortened_at: old.shortened_at || "", shortened_from: old.shortened_from || 0 }) };
    await setState(db, "pool", state);
    return json(state);
  });

  on("GET", "/api/engine/search-all", async ({ request, env, db }) => {
    requireEngine(request, env);
    const rows = (await db.prepare("SELECT user_id FROM search_all WHERE state = 'waiting' ORDER BY last_at").all()).results;
    const s = await settings(db);
    return json({ users: rows.map((r) => r.user_id), send: s.search_all_send, days: s.pool_days });
  });

  on("PUT", "/api/engine/search-all/:id", async ({ request, env, db, params }) => {
    requireEngine(request, env);
    const body = await readBody(request);
    if (!["running", "done", "waiting"].includes(body.state)) throw new HttpError(400, "bad_state");
    await db.prepare("UPDATE search_all SET state = ?, result = ? WHERE user_id = ?")
      .bind(body.state, JSON.stringify(body.result || {}), params.id).run();
    return json({ ok: true });
  });

  // ---- admin ----
  on("GET", "/api/admin/pool", async ({ request, db }) => {
    await requireAdmin(request, db);
    return json({ ...(await getState(db, "pool")), settings: await settings(db) });
  });
}

// the scheduler starts a search when someone is waiting for "search everything for me"
export async function searchAllWaiting(db) {
  return Boolean(await db.prepare("SELECT 1 FROM search_all WHERE state = 'waiting' LIMIT 1").first());
}
