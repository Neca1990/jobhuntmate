// Signing in, independent of how: a provider proves who the person is (Telegram today; Google or an email code
// later) and this module turns that into an account and a session. Adding a provider = one module in PROVIDERS
// plus its name in the "login_providers" setting; accounts and their data don't change.
//
// The flow every provider follows:
//   1. start(): the browser gets a login token (kept secret), a 2-digit number to show, and instructions
//   2. the provider reaches the person (bot link, or a message to a known account) and offers them a few numbers;
//      a 6-digit code goes along as a fallback
//   3a. approve(): they pick the number the site shows; the browser, polling with poll(), gets a session
//   3b. verify(): or the browser sends the code instead
// Picking the number shown on the site (not just "confirm") is what stops someone from getting a victim to approve
// a sign-in that happens in the attacker's browser.
import { createSession } from "../session.js";
import { HttpError, nowIso, parse, randomCode, randomToken, sameSecret, sha256 } from "../util.js";
import * as telegram from "./telegram.js";

export const PROVIDERS = { telegram };
const LOGIN_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MAX_STARTS_PER_10_MIN = 30; // all requests together; a crude brake on someone flooding the bot
const MAX_PUSHES_PER_HOUR = 3; // sign-in messages sent to one known account without them asking

export async function enabledProviders(db) {
  const row = await db.prepare("SELECT value FROM app_settings WHERE key = 'login_providers'").first();
  return parse(row?.value, ["telegram"]).filter((p) => p in PROVIDERS);
}

const twoDigits = () => String(10 + (crypto.getRandomValues(new Uint32Array(1))[0] % 90));

export async function start(env, db, providerId, { invite = "", username = "" } = {}) {
  if (!(await enabledProviders(db)).includes(providerId)) throw new HttpError(400, "provider_off");
  const now = Date.now();
  await db.prepare("DELETE FROM login_requests WHERE expires_at < ?").bind(nowIso(now)).run();
  const recent = await db.prepare("SELECT COUNT(*) AS n FROM login_requests WHERE created_at > ?")
    .bind(nowIso(now - 600_000)).first();
  if (recent.n >= MAX_STARTS_PER_10_MIN) throw new HttpError(429, "too_many_requests");
  const token = randomToken();
  const req = { token_hash: await sha256(token), rid: randomToken(12), match: twoDigits(), provider: providerId,
    chat_code: await freeChatCode(db) };
  await db.prepare("INSERT INTO login_requests (token_hash, rid, match, provider, created_at, expires_at, invite, chat_code) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(req.token_hash, req.rid, req.match, providerId, nowIso(now),
    nowIso(now + LOGIN_MINUTES * 60_000), String(invite).slice(0, 64), req.chat_code).run();
  // a known account can be reached directly; the answer is the same whether it exists or not
  if (username && PROVIDERS[providerId].push) {
    await PROVIDERS[providerId].push(env, db, req, username, { reach, maxPerHour: MAX_PUSHES_PER_HOUR });
  }
  return { token, match: req.match, chat_code: req.chat_code, expires_in: LOGIN_MINUTES * 60,
    ...PROVIDERS[providerId].instructions(env, token) };
}

// six digits no other open sign-in uses
async function freeChatCode(db) {
  for (;;) {
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 900000 + 100000);
    if (!(await db.prepare("SELECT 1 FROM login_requests WHERE chat_code = ?").bind(code).first())) return code;
  }
}

// the provider has found the person: remember who, and return what to send them (numbers to pick from and a code)
export async function reach(db, where, subject, label, contact) {
  const [col, value] = where.token ? ["token_hash", await sha256(where.token)] : where.chat_code ? ["chat_code", where.chat_code]
    : ["rid", where.rid];
  // a code sent to the bot only claims a sign-in nobody has answered yet
  const req = await db.prepare(`SELECT * FROM login_requests WHERE ${col} = ? AND expires_at > ? AND approved_at = ''` +
    (where.chat_code ? " AND subject = ''" : "")).bind(value, nowIso()).first();
  if (!req) return null;
  const code = randomCode();
  await db.prepare("UPDATE login_requests SET subject = ?, label = ?, contact = ?, code_hash = ?, attempts = 0 WHERE token_hash = ?")
    .bind(String(subject), String(label), JSON.stringify(contact || {}), await sha256(code), req.token_hash).run();
  const choices = new Set([req.match]);
  while (choices.size < 5) choices.add(twoDigits());
  return { rid: req.rid, code, choices: [...choices].sort(() => crypto.getRandomValues(new Uint8Array(1))[0] - 128) };
}

// a number tapped in the provider's app: "ok", "wrong" (the sign-in is cancelled), "not_you" or "expired"
export async function approve(db, providerId, rid, subject, number) {
  const req = await db.prepare("SELECT * FROM login_requests WHERE rid = ? AND provider = ? AND expires_at > ?")
    .bind(String(rid), providerId, nowIso()).first();
  if (!req || req.approved_at) return "expired";
  if (String(req.subject) !== String(subject)) return "not_you";
  if (String(number) !== req.match) {
    await db.prepare("DELETE FROM login_requests WHERE token_hash = ?").bind(req.token_hash).run();
    return "wrong";
  }
  await db.prepare("UPDATE login_requests SET approved_at = ? WHERE token_hash = ?").bind(nowIso(), req.token_hash).run();
  return "ok";
}

// the browser asks every couple of seconds whether its sign-in was approved
export async function poll(env, db, token) {
  const tokenHash = await sha256(String(token || ""));
  const req = await db.prepare("SELECT * FROM login_requests WHERE token_hash = ? AND expires_at > ?").bind(tokenHash, nowIso()).first();
  if (!req) throw new HttpError(400, "login_expired");
  if (!req.approved_at) return { pending: true };
  return finish(env, db, req);
}

export async function verify(env, db, token, code) {
  const tokenHash = await sha256(String(token || ""));
  const req = await db.prepare("SELECT * FROM login_requests WHERE token_hash = ? AND expires_at > ?").bind(tokenHash, nowIso()).first();
  if (!req) throw new HttpError(400, "login_expired");
  if (!req.code_hash) throw new HttpError(400, "not_confirmed_yet");
  if (req.attempts >= MAX_ATTEMPTS) throw new HttpError(429, "too_many_attempts");
  if (!sameSecret(await sha256(String(code || "").trim()), req.code_hash)) {
    await db.prepare("UPDATE login_requests SET attempts = attempts + 1 WHERE token_hash = ?").bind(tokenHash).run();
    throw new HttpError(400, "wrong_code");
  }
  return finish(env, db, req);
}

async function finish(env, db, req) {
  await db.prepare("DELETE FROM login_requests WHERE token_hash = ?").bind(req.token_hash).run(); // works once
  const user = await accountFor(env, db, req);
  return { user, cookie: await createSession(db, user.id) };
}

// the account behind this identity; a new one when registration (or an invite) allows it
async function accountFor(env, db, req) {
  const known = await db.prepare("SELECT u.* FROM identities i JOIN users u ON u.id = i.user_id WHERE i.provider = ? AND i.subject = ?")
    .bind(req.provider, req.subject).first();
  if (known) {
    if (!known.active) throw new HttpError(403, "account_disabled");
    await db.prepare("UPDATE identities SET label = ? WHERE provider = ? AND subject = ?").bind(req.label, req.provider, req.subject).run();
    await PROVIDERS[req.provider].remember?.(db, known.id, parse(req.contact, {}));
    return known;
  }
  const owner = PROVIDERS[req.provider].isOwner?.(env, req.subject);
  const reg = parse((await db.prepare("SELECT value FROM app_settings WHERE key = 'registration'").first())?.value, "invite_only");
  let invite = null;
  if (!owner && reg !== "open") {
    invite = req.invite && await db.prepare("SELECT * FROM invites WHERE code = ? AND used_by = ''").bind(req.invite).first();
    if (!invite) throw new HttpError(403, "invite_required");
  }
  const id = crypto.randomUUID();
  const now = nowIso();
  const settings = { language: "en", country: "RS", notify_via: [req.provider], searches: [], channels: {} };
  await db.batch([
    db.prepare("INSERT INTO users (id, created_at, role, settings) VALUES (?, ?, ?, ?)")
      .bind(id, now, owner ? "admin" : "user", JSON.stringify(settings)),
    db.prepare("INSERT INTO identities (provider, subject, user_id, label, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(req.provider, req.subject, id, req.label, now),
    ...(invite ? [db.prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?").bind(id, now, invite.code)] : []),
  ]);
  await PROVIDERS[req.provider].remember?.(db, id, parse(req.contact, {}));
  return { id, role: owner ? "admin" : "user", active: 1, created_at: now, settings: JSON.stringify(settings) };
}

export const newInviteCode = () => randomToken(9);
