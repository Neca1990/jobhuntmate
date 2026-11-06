// The person's own data: accepting the privacy notice, a copy of everything kept about them, and deleting it all.
// The notice itself is site/privacy.html; PRIVACY_VERSION changes when it changes in substance, and everyone is
// asked to accept it again.
import { clearCookie } from "./session.js";
import { HttpError, json, nowIso, parse, readBody } from "./util.js";

export const PRIVACY_VERSION = "2026-11-06";

export function routes(on, { requireUser }) {
  on("POST", "/api/me/consent", async ({ request, db }) => {
    const user = await requireUser(request, db);
    const body = await readBody(request);
    if (body.version !== PRIVACY_VERSION) throw new HttpError(400, "old_version");
    await db.prepare("UPDATE users SET consent_version = ?, consent_at = ? WHERE id = ?").bind(PRIVACY_VERSION, nowIso(), user.id).run();
    return json({ ok: true, version: PRIVACY_VERSION });
  });

  // everything kept about the person, except the sign-in internals (sessions) and other people's data;
  // the files themselves are fetched one by one from /api/files/:id and zipped in the browser
  on("GET", "/api/me/export", async ({ request, db }) => {
    const user = await requireUser(request, db);
    const all = async (sql) => (await db.prepare(sql).bind(user.id).all()).results;
    const row = await db.prepare("SELECT id, created_at, role, consent_version, consent_at FROM users WHERE id = ?").bind(user.id).first();
    return json({
      exported_at: nowIso(),
      account: { ...row, identities: await all("SELECT provider, subject, label, created_at FROM identities WHERE user_id = ?") },
      settings: user.settings,
      applications: (await all("SELECT data, updated_at FROM applications WHERE user_id = ? ORDER BY updated_at"))
        .map((r) => ({ ...parse(r.data, {}), updated_at: r.updated_at })),
      agencies: (await all("SELECT agency_id, data, updated_at FROM user_agencies WHERE user_id = ? ORDER BY updated_at"))
        .map((r) => ({ agency_id: r.agency_id, ...parse(r.data, {}), updated_at: r.updated_at })),
      requests: await all("SELECT id, kind, target, note, file_id, status, created_at, done_at FROM requests WHERE user_id = ? ORDER BY created_at"),
      search_everything: (await all("SELECT state, day, count, last_at, result FROM search_all WHERE user_id = ?"))
        .map((r) => ({ ...r, result: parse(r.result, {}) }))[0] || null,
      search_state: Object.fromEntries((await all("SELECT name, data FROM user_files WHERE user_id = ?")).map((r) => [r.name, parse(r.data, null)])),
      files: await all("SELECT id, kind, name, mime, size, made_by, created_at FROM files WHERE user_id = ? ORDER BY created_at"),
      known_browsers: await all("SELECT d.provider, d.first_at, d.last_at FROM devices d JOIN identities i ON i.provider = d.provider " +
        "AND i.subject = d.subject WHERE i.user_id = ? ORDER BY d.last_at"),
    });
  });

  // deletes the account and everything tied to it (the database removes the rest with it); the last admin stays
  on("DELETE", "/api/me", async ({ request, db }) => {
    const user = await requireUser(request, db);
    const body = await readBody(request);
    if (body.confirm !== "DELETE") throw new HttpError(400, "confirm_needed");
    if (user.role === "admin") {
      const admins = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").first();
      if ((admins?.n || 0) <= 1) throw new HttpError(400, "last_admin");
    }
    await db.batch([
      db.prepare("DELETE FROM devices WHERE (provider, subject) IN (SELECT provider, subject FROM identities WHERE user_id = ?)").bind(user.id),
      db.prepare("UPDATE invites SET used_by = 'deleted' WHERE used_by = ?").bind(user.id),
      db.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
    ]);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json", "set-cookie": clearCookie() } });
  });
}
