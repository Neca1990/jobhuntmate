// Sessions: a random value in an HttpOnly cookie; only its SHA-256 is stored, so a leaked database can't be used to
// sign in as anyone.
import { HttpError, nowIso, parse, randomToken, sha256 } from "./util.js";

export const COOKIE = "session";
const DAYS = 30;

export async function createSession(db, userId) {
  const value = randomToken();
  const now = Date.now();
  await db.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(value), userId, nowIso(now), nowIso(now + DAYS * 86400_000)).run();
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${DAYS * 86400}`;
}

function cookieValue(request) {
  const raw = request.headers.get("cookie") || "";
  const hit = raw.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
  return hit ? hit.slice(COOKIE.length + 1) : "";
}

// the signed-in, active user, or null
export async function currentUser(request, db) {
  const value = cookieValue(request);
  if (!value) return null;
  const row = await db.prepare(
    "SELECT u.id, u.role, u.active, u.settings, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id " +
    "WHERE s.id_hash = ? AND s.expires_at > ?").bind(await sha256(value), nowIso()).first();
  if (!row || !row.active) return null;
  return { ...row, settings: parse(row.settings, {}) };
}

export async function requireUser(request, db) {
  const user = await currentUser(request, db);
  if (!user) throw new HttpError(401, "not_signed_in");
  return user;
}

export async function endSession(request, db) {
  const value = cookieValue(request);
  if (value) await db.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256(value)).run();
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
