// Files on the account (CVs), recruitment agencies (a shared catalog plus each user's dealings with them) and
// requests for a tailored CV and email, which the owner (or later the Claude API) fulfils.
import { HttpError, json, nowIso, parse, readBody } from "./util.js";

const MAX_FILE = 1_500_000; // bytes; the database keeps up to ~2 MB in one row
const MIMES = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain" };
const AGENCY_KEYS = ["status", "note", "file_id", "mail", "followup_mail", "sent_on", "followup_requested", "followup_sent_on"];
const OWN_KEYS = ["name", "email", "site", "contact", "language"];
const STATUSES = ["suggested", "new", "waiting", "ready", "sent", "replied", "interview", "no_reply", "rejected", "dismissed"];

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function saveFile(db, userId, { name, data, kind = "cv", madeBy = "user" }) {
  const ext = String(name || "").toLowerCase().split(".").pop();
  if (!MIMES[ext]) throw new HttpError(400, "unsupported_file");
  const bytes = b64ToBytes(String(data || ""));
  if (!bytes.length || bytes.length > MAX_FILE) throw new HttpError(413, "file_too_large");
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO files (id, user_id, kind, name, mime, size, data, made_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, userId, ["cv", "letter", "other"].includes(kind) ? kind : "other", String(name).slice(0, 120), MIMES[ext],
      bytes.length, bytes, madeBy, nowIso()).run();
  return { id, name, size: bytes.length, kind, made_by: madeBy };
}

export async function fileResponse(db, id, userId) {
  const row = await db.prepare(`SELECT name, mime, data FROM files WHERE id = ?${userId ? " AND user_id = ?" : ""}`)
    .bind(...(userId ? [id, userId] : [id])).first();
  if (!row) throw new HttpError(404, "not_found");
  const body = row.data instanceof ArrayBuffer ? new Uint8Array(row.data) : Uint8Array.from(row.data);
  return new Response(body, { headers: { "content-type": row.mime, "cache-control": "no-store",
    "content-disposition": `attachment; filename="${row.name.replace(/[^\w.() -]/g, "_")}"` } });
}

async function mine(db, userId, agencyId) {
  const row = await db.prepare("SELECT data FROM user_agencies WHERE user_id = ? AND agency_id = ?").bind(userId, agencyId).first();
  return row ? parse(row.data, {}) : null;
}
export async function saveMine(db, userId, agencyId, data) {
  await db.prepare("INSERT INTO user_agencies (user_id, agency_id, data, updated_at) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(user_id, agency_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
    .bind(userId, agencyId, JSON.stringify(data), nowIso()).run();
}

export function routes(on, { requireUser, requireEngine }) {
  // ---------- files ----------
  on("GET", "/api/files", async ({ request, db }) => {
    const user = await requireUser(request, db);
    const rows = await db.prepare("SELECT id, kind, name, size, made_by, created_at FROM files WHERE user_id = ? ORDER BY created_at DESC")
      .bind(user.id).all();
    return json({ files: rows.results });
  });
  on("POST", "/api/files", async ({ request, db }) => {
    const user = await requireUser(request, db);
    const body = await readBody(request, 2_200_000);
    return json(await saveFile(db, user.id, body));
  });
  on("GET", "/api/files/:id", async ({ request, db, params }) => fileResponse(db, params.id, (await requireUser(request, db)).id));
  on("DELETE", "/api/files/:id", async ({ request, db, params }) => {
    const user = await requireUser(request, db);
    await db.prepare("DELETE FROM files WHERE id = ? AND user_id = ?").bind(params.id, user.id).run();
    return json({ ok: true });
  });

  // ---------- agencies ----------
  on("GET", "/api/agencies", async ({ request, db }) => {
    const user = await requireUser(request, db);
    const catalog = (await db.prepare("SELECT id, data FROM agencies WHERE active = 1").all()).results
      .map((r) => ({ id: r.id, ...parse(r.data, {}) }));
    const rows = (await db.prepare("SELECT agency_id, data FROM user_agencies WHERE user_id = ?").bind(user.id).all()).results;
    return json({ catalog, mine: Object.fromEntries(rows.map((r) => [r.agency_id, parse(r.data, {})])) });
  });
  on("PUT", "/api/agencies/:id", async ({ request, db, params }) => {
    const user = await requireUser(request, db);
    const body = await readBody(request, 128 * 1024);
    const known = params.id.startsWith("own:") ? await mine(db, user.id, params.id)
      : await db.prepare("SELECT id FROM agencies WHERE id = ?").bind(params.id).first();
    if (!known) throw new HttpError(404, "not_found");
    const data = { ...((await mine(db, user.id, params.id)) || {}) };
    for (const k of AGENCY_KEYS) if (k in body) data[k] = body[k];
    if (params.id.startsWith("own:")) for (const k of OWN_KEYS) if (k in body) data[k] = String(body[k] || "").slice(0, 300);
    if (data.status && !STATUSES.includes(data.status)) throw new HttpError(400, "bad_status");
    if (body.status === "sent" && !data.sent_on) data.sent_on = nowIso().slice(0, 10);
    await saveMine(db, user.id, params.id, data);
    return json({ agency: data });
  });
  on("POST", "/api/agencies", async ({ request, db }) => {
    const user = await requireUser(request, db);
    const body = await readBody(request);
    if (!String(body.name || "").trim()) throw new HttpError(400, "name_required");
    const id = `own:${crypto.randomUUID()}`;
    const data = { status: "new", note: String(body.note || "").slice(0, 2000) };
    for (const k of OWN_KEYS) data[k] = String(body[k] || "").slice(0, 300);
    await saveMine(db, user.id, id, data);
    return json({ id, agency: data });
  });
  on("DELETE", "/api/agencies/:id", async ({ request, db, params }) => {
    const user = await requireUser(request, db);
    await db.prepare("DELETE FROM user_agencies WHERE user_id = ? AND agency_id = ?").bind(user.id, params.id).run();
    return json({ ok: true });
  });

  // ---------- requests for a tailored CV and email ----------
  on("POST", "/api/requests", async ({ request, db }) => {
    const user = await requireUser(request, db);
    const body = await readBody(request, 16 * 1024);
    if (body.kind !== "agency_mail") throw new HttpError(400, "bad_kind");
    const data = (await mine(db, user.id, body.target)) || {};
    const id = crypto.randomUUID();
    await db.batch([
      db.prepare("UPDATE requests SET status = 'cancelled' WHERE user_id = ? AND target = ? AND status = 'waiting'").bind(user.id, body.target),
      db.prepare("INSERT INTO requests (id, user_id, kind, target, note, file_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(id, user.id, body.kind, String(body.target), String(body.note || "").slice(0, 2000), String(body.file_id || ""), nowIso()),
    ]);
    await saveMine(db, user.id, body.target, { ...data, status: "waiting", note: String(body.note || data.note || "").slice(0, 2000),
      file_id: body.file_id || data.file_id || "", requested_at: nowIso() });
    return json({ id });
  });

  // the owner's side (tools/requests.py, with the engine key): what is waiting, and the finished CV and email
  on("GET", "/api/engine/requests", async ({ request, env, db }) => {
    requireEngine(request, env);
    const rows = (await db.prepare("SELECT r.*, u.settings FROM requests r JOIN users u ON u.id = r.user_id " +
      "WHERE r.status = 'waiting' ORDER BY r.created_at").all()).results;
    const out = [];
    for (const r of rows) {
      const agency = r.target.startsWith("own:") ? await mine(db, r.user_id, r.target)
        : parse((await db.prepare("SELECT data FROM agencies WHERE id = ?").bind(r.target).first())?.data, {});
      const file = r.file_id && await db.prepare("SELECT id, name, size FROM files WHERE id = ? AND user_id = ?").bind(r.file_id, r.user_id).first();
      const s = parse(r.settings, {});
      out.push({ id: r.id, kind: r.kind, target: r.target, note: r.note, created_at: r.created_at, agency, file: file || null,
        user: { id: r.user_id, name: s.name || "", language: s.language || "en", country: s.country || "" } });
    }
    return json({ requests: out });
  });
  on("GET", "/api/engine/files/:id", async ({ request, env, db, params }) => {
    requireEngine(request, env);
    return fileResponse(db, params.id);
  });
  on("PUT", "/api/engine/requests/:id", async ({ request, env, db, params }) => {
    requireEngine(request, env);
    const body = await readBody(request, 2_400_000);
    const req = await db.prepare("SELECT * FROM requests WHERE id = ? AND status = 'waiting'").bind(params.id).first();
    if (!req) throw new HttpError(404, "not_found");
    const data = (await mine(db, req.user_id, req.target)) || {};
    if (body.file) {
      const f = await saveFile(db, req.user_id, { ...body.file, kind: "cv", madeBy: "tailored" });
      data.cv_file_id = f.id;
    }
    if (body.mail) data.mail = { to: String(body.mail.to || ""), subject: String(body.mail.subject || ""), body: String(body.mail.body || "") };
    data.status = "ready";
    data.ready_at = nowIso();
    await saveMine(db, req.user_id, req.target, data);
    await db.prepare("UPDATE requests SET status = 'done', done_at = ? WHERE id = ?").bind(nowIso(), params.id).run();
    return json({ ok: true });
  });
  // the shared catalog is put here by the owner's tools, never kept in the repository
  on("PUT", "/api/engine/agencies", async ({ request, env, db }) => {
    requireEngine(request, env);
    const list = await readBody(request, 1024 * 1024);
    if (!Array.isArray(list)) throw new HttpError(400, "bad_list");
    await db.batch(list.filter((a) => a?.id).map((a) => db.prepare(
      "INSERT INTO agencies (id, data, active, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
      .bind(String(a.id), JSON.stringify({ ...a, id: undefined }), nowIso())));
    return json({ saved: list.length });
  });
}

export { bytesToB64 };
