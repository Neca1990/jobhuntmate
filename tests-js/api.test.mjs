import assert from "node:assert/strict";
import { PRIVACY_VERSION } from "../functions/_lib/privacy.js";
import { beforeEach, test } from "node:test";

import { handle } from "../functions/_lib/routes.js";
import { testDb } from "./d1.mjs";

const OWNER = 1001;
const SECRET = "webhook-secret";
let env, sent;

beforeEach(() => {
  env = { DB: testDb(), TELEGRAM_BOT_TOKEN: "t", TELEGRAM_WEBHOOK_SECRET: SECRET, OWNER_TELEGRAM_ID: String(OWNER), ENGINE_KEY: "engine-key" };
  sent = [];
  // the bot's messages are captured instead of sent
  globalThis.fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
  };
});

function call(method, path, { body, cookie, headers = {} } = {}) {
  return handle(new Request(`https://site.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env);
}

const webhook = (from, text, chatType = "private") => call("POST", "/api/telegram", {
  headers: { "x-telegram-bot-api-secret-token": SECRET },
  body: { update_id: 1, message: { message_id: 5, from: { id: from, username: `user${from}` }, chat: { id: from, type: chatType }, text } },
});

// the whole Telegram sign-in: start on the site, Start in the bot, type the code
async function signIn(telegramId, invite = "", consent = true) {
  const start = await (await call("POST", "/api/auth/telegram/start", { body: { invite } })).json();
  await webhook(telegramId, `/start ${start.token}`);
  const code = sent.at(-1).body.text.match(/<code>(\d{6})<\/code>/)?.[1];
  let res = await call("POST", "/api/auth/verify", { body: { token: start.token, code } });
  // a browser new to this Telegram account asks "is this you?" first
  if (res.status === 200 && (await res.clone().json()).confirm) {
    res = await call("POST", "/api/auth/confirm", { body: { token: start.token, yes: true } });
  }
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  // like on the site: the privacy notice is accepted right after the first sign-in
  if (res.status === 200 && consent) await call("POST", "/api/me/consent", { cookie, body: { version: PRIVACY_VERSION } });
  return { res, cookie, start, code };
}

test("the owner signs in with a Telegram code and becomes admin", async () => {
  const { res, cookie, start } = await signIn(OWNER);
  assert.equal(res.status, 200);
  assert.match(start.link, /^https:\/\/t\.me\/\w+\?start=[\w-]{20,64}$/);
  assert.match(cookie, /^session=/);
  const me = await (await call("GET", "/api/me", { cookie })).json();
  assert.equal(me.role, "admin");
  assert.deepEqual(me.identities.map((i) => [i.provider, i.label]), [["telegram", `@user${OWNER}`]]);
  assert.equal(me.settings.channels.telegram.chat_id, OWNER); // notifications go to the same chat
  // the session cookie is stored only as a hash
  const row = env.DB.raw.prepare("SELECT id_hash FROM sessions").get();
  assert.ok(!cookie.includes(row.id_hash));
});

test("strangers need an invite; an invite works once", async () => {
  const blocked = await signIn(2002);
  assert.equal(blocked.res.status, 403);
  assert.equal((await blocked.res.json()).error, "invite_required");

  const { cookie: admin } = await signIn(OWNER);
  const { code } = await (await call("POST", "/api/admin/invites", { cookie: admin, body: { note: "friend" } })).json();
  const ok = await signIn(2002, code);
  assert.equal(ok.res.status, 200);
  const me = await (await call("GET", "/api/me", { cookie: ok.cookie })).json();
  assert.equal(me.role, "user");
  assert.equal((await signIn(3003, code)).res.status, 403); // already used
  assert.equal((await call("GET", "/api/admin/users", { cookie: ok.cookie })).status, 403); // not an admin
});

test("open registration lets anyone in", async () => {
  const { cookie: admin } = await signIn(OWNER);
  assert.equal((await call("PUT", "/api/admin/settings", { cookie: admin, body: { registration: "open" } })).status, 200);
  assert.equal((await signIn(4004)).res.status, 200);
  assert.equal((await call("PUT", "/api/admin/settings", { cookie: admin, body: { registration: "anyone" } })).status, 400);
});

test("a wrong code counts, and five of them lock the sign-in", async () => {
  const start = await (await call("POST", "/api/auth/telegram/start", { body: {} })).json();
  await webhook(OWNER, `/start ${start.token}`);
  const code = sent.at(-1).body.text.match(/<code>(\d{6})<\/code>/)[1];
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) {
    assert.equal((await (await call("POST", "/api/auth/verify", { body: { token: start.token, code: wrong } })).json()).error, "wrong_code");
  }
  const locked = await call("POST", "/api/auth/verify", { body: { token: start.token, code } });
  assert.equal(locked.status, 429);
});

test("a code works once and only with its own token", async () => {
  const a = await signIn(OWNER);
  assert.equal(a.res.status, 200);
  assert.equal((await call("POST", "/api/auth/verify", { body: { token: a.start.token, code: a.code } })).status, 400);
  const other = await (await call("POST", "/api/auth/telegram/start", { body: {} })).json();
  assert.equal((await (await call("POST", "/api/auth/verify", { body: { token: other.token, code: a.code } })).json()).error,
    "not_confirmed_yet");
});

test("the webhook needs Telegram's secret and ignores group chats", async () => {
  const start = await (await call("POST", "/api/auth/telegram/start", { body: {} })).json();
  const forged = await call("POST", "/api/telegram", { body: { message: { text: `/start ${start.token}` } } });
  assert.equal(forged.status, 403);
  await webhook(OWNER, `/start ${start.token}`, "group");
  assert.equal(sent.length, 0);
});

test("signing out ends the session", async () => {
  const { cookie } = await signIn(OWNER);
  await call("POST", "/api/auth/logout", { cookie });
  assert.equal((await call("GET", "/api/me", { cookie })).status, 401);
});

test("settings keep only known fields and never the connected chats", async () => {
  const { cookie } = await signIn(OWNER);
  const res = await call("PUT", "/api/me/settings", { cookie, body: {
    language: "sr", country: "RS", role: "admin", channels: { telegram: { chat_id: 999 } }, searches: [{ id: "s1" }] } });
  const { settings } = await res.json();
  assert.equal(settings.language, "sr");
  assert.equal(settings.role, undefined);
  assert.equal(settings.channels.telegram.chat_id, OWNER);
});

test("the engine reads users and adds postings, without undoing the user's changes", async () => {
  const { cookie } = await signIn(OWNER);
  const engine = { authorization: "Bearer engine-key" };
  assert.equal((await call("GET", "/api/engine/users", { headers: { authorization: "Bearer nope" } })).status, 403);
  const { users } = await (await call("GET", "/api/engine/users", { headers: engine })).json();
  assert.equal(users.length, 1);
  const uid = users[0].id;
  await call("PUT", `/api/engine/users/${uid}/applications`, { headers: engine, body: [{ id: "j1", status: "pending", title: "QA" }] });
  await call("PATCH", "/api/applications/j1", { cookie, body: { status: "approved", note: "looks good" } });
  // the next run sends its whole list again: the existing one keeps the user's status, new ones are added
  const r = await (await call("PUT", `/api/engine/users/${uid}/applications`, { headers: engine,
    body: [{ id: "j1", status: "pending" }, { id: "j2", status: "pending" }] })).json();
  assert.equal(r.added, 1);
  const { applications } = await (await call("GET", "/api/applications", { cookie })).json();
  const j1 = applications.find((a) => a.id === "j1");
  assert.equal(j1.status, "approved");
  assert.equal(j1.notes[0].text, "looks good");
  await call("PUT", `/api/engine/users/${uid}/seen`, { headers: engine, body: { j1: { status: "sent" } } });
  assert.deepEqual(await (await call("GET", `/api/engine/users/${uid}/seen`, { headers: engine })).json(), { j1: { status: "sent" } });
});

test("an admin can't lock themselves out, and a disabled user loses their sessions", async () => {
  const { cookie: admin } = await signIn(OWNER);
  await call("PUT", "/api/admin/settings", { cookie: admin, body: { registration: "open" } });
  const friend = await signIn(5005);
  const me = await (await call("GET", "/api/me", { cookie: admin })).json();
  assert.equal((await call("PATCH", `/api/admin/users/${me.id}`, { cookie: admin, body: { active: false } })).status, 400);
  const { id } = await (await call("GET", "/api/me", { cookie: friend.cookie })).json();
  await call("PATCH", `/api/admin/users/${id}`, { cookie: admin, body: { active: false } });
  assert.equal((await call("GET", "/api/me", { cookie: friend.cookie })).status, 401);
});


const tap = (from, data) => call("POST", "/api/telegram", {
  headers: { "x-telegram-bot-api-secret-token": SECRET },
  body: { update_id: 2, callback_query: { id: "q1", from: { id: from }, data, message: { message_id: 9, chat: { id: from } } } },
});
const buttons = (msg) => msg.body.reply_markup.inline_keyboard[0].map((b) => b.callback_data);

test("tapping the number shown on the site signs the browser in", async () => {
  const start = await (await call("POST", "/api/auth/telegram/start", { body: {} })).json();
  assert.match(start.match, /^\d{2}$/);
  assert.match(start.app_link, /^tg:\/\/resolve\?domain=\w+&start=/);
  await webhook(OWNER, `/start ${start.token}`);
  const choices = buttons(sent.at(-1));
  assert.equal(choices.length, 5);
  const right = choices.find((d) => d.endsWith(`:${start.match}`));
  assert.ok(right);
  assert.deepEqual(await (await call("POST", "/api/auth/poll", { body: { token: start.token } })).json(), { pending: true });
  await tap(OWNER, right);
  // a browser this Telegram account hasn't used: "is this you?" with the name Telegram gave
  const ask = await (await call("POST", "/api/auth/poll", { body: { token: start.token } })).json();
  assert.deepEqual(ask, { confirm: true, label: `@user${OWNER}`, new_account: true });
  const done = await call("POST", "/api/auth/confirm", { body: { token: start.token, yes: true } });
  assert.equal(done.status, 200);
  const cookies = done.headers.getSetCookie();
  assert.match(cookies[0], /^session=/);
  assert.match(cookies[1], /^device=[\w-]{20,}; .*Max-Age=31536000/);
  assert.equal((await call("POST", "/api/auth/poll", { body: { token: start.token } })).status, 400); // used up
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM devices").get().n, 1);
});

// one sign-in from a given browser (device cookie), answered in Telegram by `from`
async function tappedSignIn(from, device = "") {
  const start = await (await call("POST", "/api/auth/telegram/start", { body: {} })).json();
  await webhook(from, `/start ${start.token}`);
  await tap(from, buttons(sent.at(-1)).find((d) => d.endsWith(`:${start.match}`)));
  const res = await call("POST", "/api/auth/poll", { body: { token: start.token }, headers: device ? { cookie: `device=${device}` } : {} });
  return { start, res, body: await res.clone().json() };
}

test("a known browser signs in without asking; another account on it, or a refusal, is handled", async () => {
  const first = await tappedSignIn(OWNER);
  const done = await call("POST", "/api/auth/confirm", { body: { token: first.start.token, yes: true } });
  const device = done.headers.getSetCookie()[1].match(/^device=([\w-]+)/)[1];
  // the same Telegram account on the same browser: straight in
  const again = await tappedSignIn(OWNER, device);
  assert.equal(again.body.ok, true);
  assert.match(again.res.headers.getSetCookie()[0], /^session=/);
  // someone else answers this browser's sign-in (e.g. was given the code): the browser asks, and can say no
  const other = await tappedSignIn(2002, device);
  assert.equal(other.body.confirm, true);
  assert.equal(other.body.label, "@user2002");
  sent = [];
  const no = await (await call("POST", "/api/auth/confirm", { body: { token: other.start.token, yes: false } })).json();
  assert.deepEqual(no, { cancelled: true });
  assert.equal(sent[0].body.chat_id, 2002);
  assert.match(sent[0].body.text, /refused on the site/);
  assert.equal((await call("POST", "/api/auth/confirm", { body: { token: other.start.token, yes: true } })).status, 400); // gone
  // a "yes" needs a sign-in that was answered in Telegram
  const fresh = await (await call("POST", "/api/auth/telegram/start", { body: {} })).json();
  assert.equal((await call("POST", "/api/auth/confirm", { body: { token: fresh.token, yes: true } })).status, 400);
});

test("a wrong number cancels the sign-in, and someone else's tap does nothing", async () => {
  const start = await (await call("POST", "/api/auth/telegram/start", { body: {} })).json();
  await webhook(OWNER, `/start ${start.token}`);
  const choices = buttons(sent.at(-1));
  const right = choices.find((d) => d.endsWith(`:${start.match}`));
  await tap(9999, right); // not the person who pressed Start
  assert.deepEqual(await (await call("POST", "/api/auth/poll", { body: { token: start.token } })).json(), { pending: true });
  await tap(OWNER, choices.find((d) => d !== right));
  assert.equal((await call("POST", "/api/auth/poll", { body: { token: start.token } })).status, 400);
});

test("typing someone's @username sends them nothing (only a remembered browser gets the numbers pushed)", async () => {
  await signIn(OWNER);
  sent = [];
  const r = await (await call("POST", "/api/auth/telegram/start", { body: { username: `@user${OWNER}` } })).json();
  assert.deepEqual([r.known, r.pushed, sent.length], [false, false, 0]);
});

test("nobody can flood a known account with sign-in prompts", async () => {
  await signIn(OWNER);
  sent = [];
  for (let i = 0; i < 6; i++) await call("POST", "/api/auth/telegram/start", { body: { username: "user1001" } });
  assert.ok(sent.length <= 3, `sent ${sent.length}`);
});

test("a tap on a job card's button changes its status right away, once", async () => {
  const { cookie } = await signIn(OWNER);
  const engine = { authorization: "Bearer engine-key" };
  const { users } = await (await call("GET", "/api/engine/users", { headers: engine })).json();
  await call("PUT", `/api/engine/users/${users[0].id}/applications`, { headers: engine, body: [{ id: "abc123", status: "pending" }] });
  sent = [];
  await tap(OWNER, "approve:abc123");
  const { applications } = await (await call("GET", "/api/applications", { cookie })).json();
  assert.equal(applications[0].status, "approved");
  assert.equal(sent.find((m) => m.url.endsWith("/editMessageReplyMarkup")).body.reply_markup.inline_keyboard[0][0].text, "✅ Approved – CV to do");
  await tap(OWNER, "skip:abc123"); // already decided: stays approved
  assert.equal((await (await call("GET", "/api/applications", { cookie })).json()).applications[0].status, "approved");
  await tap(9999, "skip:abc123"); // a stranger's tap finds nothing
  assert.equal((await (await call("GET", "/api/applications", { cookie })).json()).applications[0].status, "approved");
});

test("the search is due only when someone is in their active hours and their interval has passed", async () => {
  const { isDue } = await import("../functions/_lib/schedule.js");
  const user = { country: "RS", searches: [{ id: "s" }], schedule: { interval_hours: 2, active_from: "08:00", active_to: "22:00" } };
  const noonBelgrade = new Date("2026-11-06T11:00:00Z");
  assert.equal(isDue([user], null, noonBelgrade).due, true);
  assert.equal(isDue([user], "2026-11-06T10:30:00Z", noonBelgrade).due, false);
  assert.equal(isDue([user], "2026-11-06T09:00:00Z", noonBelgrade).due, true);
  assert.equal(isDue([user], null, new Date("2026-11-06T02:00:00Z")).reason, "nobody_active"); // 03:00 in Belgrade
  assert.equal(isDue([{ ...user, searches: [] }], null, noonBelgrade).due, false); // nothing to search for
});

test("company boards found by the search are kept by the site", async () => {
  const engine = { authorization: "Bearer engine-key" };
  assert.equal(await (await call("GET", "/api/engine/companies", { headers: engine })).json(), null);
  await call("PUT", "/api/engine/companies", { headers: engine, body: { companies: [{ ats: "board", slug: "acme" }] } });
  assert.equal((await (await call("GET", "/api/engine/companies", { headers: engine })).json()).companies[0].slug, "acme");
});

test("a status changed on the site shows on the Telegram message too", async () => {
  const { cookie } = await signIn(OWNER);
  const engine = { authorization: "Bearer engine-key" };
  const { users } = await (await call("GET", "/api/engine/users", { headers: engine })).json();
  await call("PUT", `/api/engine/users/${users[0].id}/applications`, { headers: engine,
    body: [{ id: "x1", status: "pending", refs: { telegram: { chat_id: OWNER, message_id: 42 } } }] });
  sent = [];
  await call("PATCH", "/api/applications/x1", { cookie, body: { status: "sent" } });
  const edit = sent.find((m) => m.url.endsWith("/editMessageReplyMarkup"));
  assert.equal(edit.body.message_id, 42);
  assert.equal(edit.body.reply_markup.inline_keyboard[0][0].text, "📨 Applied");
  sent = [];
  await call("PATCH", "/api/applications/x1", { cookie, body: { status: "pending" } }); // back to undecided: buttons return
  assert.deepEqual(sent[0].body.reply_markup.inline_keyboard[0].map((b) => b.callback_data), ["approve:x1", "skip:x1"]);
  sent = [];
  await call("PATCH", "/api/applications/x1", { cookie, body: { note: "called them" } }); // a note alone changes nothing there
  assert.equal(sent.length, 0);
});

test("a CV kept on the account: upload, list, download (own only), delete", async () => {
  const { cookie } = await signIn(OWNER);
  const pdf = Buffer.from("%PDF-1.4 test cv").toString("base64");
  const f = await (await call("POST", "/api/files", { cookie, body: { name: "cv.pdf", data: pdf } })).json();
  assert.equal(f.size, 16);
  assert.equal((await (await call("GET", "/api/files", { cookie })).json()).files.length, 1);
  const dl = await call("GET", `/api/files/${f.id}`, { cookie });
  assert.equal(dl.headers.get("content-type"), "application/pdf");
  assert.equal(Buffer.from(await dl.arrayBuffer()).toString(), "%PDF-1.4 test cv");
  assert.equal((await call("POST", "/api/files", { cookie, body: { name: "x.exe", data: pdf } })).status, 400);
  await call("PUT", "/api/admin/settings", { cookie, body: { registration: "open" } });
  const other = await signIn(6006);
  assert.equal((await call("GET", `/api/files/${f.id}`, { cookie: other.cookie })).status, 404); // not theirs
  await call("DELETE", `/api/files/${f.id}`, { cookie });
  assert.equal((await (await call("GET", "/api/files", { cookie })).json()).files.length, 0);
});

test("agencies: the shared catalog, each user's own status, and a request the owner fulfils", async () => {
  const { cookie } = await signIn(OWNER);
  const engine = { authorization: "Bearer engine-key" };
  await call("PUT", "/api/engine/agencies", { headers: engine, body: [{ id: "a1", name: "Agency One", email: "jobs@one.test" }] });
  let r = await (await call("GET", "/api/agencies", { cookie })).json();
  assert.equal(r.catalog[0].name, "Agency One");
  assert.deepEqual(r.mine, {});
  await call("PUT", "/api/agencies/a1", { cookie, body: { status: "new", role: "admin" } });
  const own = await (await call("POST", "/api/agencies", { cookie, body: { name: "My Recruiter", email: "me@rec.test" } })).json();
  const cv = await (await call("POST", "/api/files", { cookie, body: { name: "cv.pdf", data: Buffer.from("%PDF").toString("base64") } })).json();
  await call("POST", "/api/requests", { cookie, body: { kind: "agency_mail", target: "a1", note: "remote only", file_id: cv.id } });
  r = await (await call("GET", "/api/agencies", { cookie })).json();
  assert.equal(r.mine.a1.status, "waiting");
  assert.equal(r.mine.a1.role, undefined);
  assert.equal(r.mine[own.id].name, "My Recruiter");
  // the owner's side picks it up and sends back the CV and email
  const { requests } = await (await call("GET", "/api/engine/requests", { headers: engine })).json();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].agency.name, "Agency One");
  assert.equal(requests[0].file.id, cv.id);
  await call("PUT", `/api/engine/requests/${requests[0].id}`, { headers: engine, body: {
    mail: { to: "jobs@one.test", subject: "QA engineer", body: "Hello" },
    file: { name: "tailored.pdf", data: Buffer.from("%PDF tailored").toString("base64") } } });
  r = await (await call("GET", "/api/agencies", { cookie })).json();
  assert.equal(r.mine.a1.status, "ready");
  assert.equal(r.mine.a1.mail.subject, "QA engineer");
  const files = (await (await call("GET", "/api/files", { cookie })).json()).files;
  assert.equal(files.find((f) => f.id === r.mine.a1.cv_file_id).made_by, "tailored");
  assert.equal((await (await call("GET", "/api/engine/requests", { headers: engine })).json()).requests.length, 0);
});

test("a tailored CV and cover letter for a job posting: request, owner's side, ready on the site and on Telegram", async () => {
  const { cookie } = await signIn(OWNER);
  const engine = { authorization: "Bearer engine-key" };
  const { users } = await (await call("GET", "/api/engine/users", { headers: engine })).json();
  await call("PUT", `/api/engine/users/${users[0].id}/applications`, { headers: engine,
    body: [{ id: "job1", status: "approved", title: "QA Engineer", company: "Acme", refs: { telegram: { chat_id: OWNER, message_id: 77 } } }] });
  await call("PUT", "/api/engine/postings/job1", { headers: engine, body: { id: "job1", description_text: "We test things." } });
  assert.equal((await call("POST", "/api/requests", { cookie, body: { kind: "job_cv", target: "nope" } })).status, 404);
  await call("POST", "/api/requests", { cookie, body: { kind: "job_cv", target: "job1", note: "stress API testing", letter: true } });
  let app = (await (await call("GET", "/api/applications", { cookie })).json()).applications[0];
  assert.equal(app.cv_state, "waiting");
  assert.equal(app.status, "approved");
  const { requests } = await (await call("GET", "/api/engine/requests", { headers: engine })).json();
  assert.equal(requests[0].kind, "job_cv");
  assert.equal(requests[0].posting.description_text, "We test things.");
  assert.equal(requests[0].want_letter, true);
  sent = [];
  await call("PUT", `/api/engine/requests/${requests[0].id}`, { headers: engine, body: {
    file: { name: "cv.pdf", data: Buffer.from("%PDF cv").toString("base64") },
    letter: { name: "letter.pdf", data: Buffer.from("%PDF letter").toString("base64") } } });
  app = (await (await call("GET", "/api/applications", { cookie })).json()).applications[0];
  assert.equal(app.cv_state, "ready");
  assert.equal(app.status, "ready");
  assert.ok(app.cv_file_id && app.letter_file_id);
  assert.equal(sent.find((m) => m.url.endsWith("/editMessageReplyMarkup")).body.reply_markup.inline_keyboard[0][0].text, "📄 CV ready");
  assert.match(sent.find((m) => m.url.endsWith("/sendMessage")).body.text, /Ready: your CV and cover letter for QA Engineer – Acme/);
  // asking for changes keeps the first version in the history
  await call("POST", "/api/requests", { cookie, body: { kind: "job_cv", target: "job1", change: "shorter summary" } });
  const again = (await (await call("GET", "/api/engine/requests", { headers: engine })).json()).requests[0];
  assert.match(again.note, /^CHANGE: shorter summary/);
  await call("PUT", `/api/engine/requests/${again.id}`, { headers: engine, body: { file: { name: "cv2.pdf", data: Buffer.from("%PDF v2").toString("base64") } } });
  app = (await (await call("GET", "/api/applications", { cookie })).json()).applications[0];
  assert.equal(app.history.length, 1);
  assert.notEqual(app.history[0].cv_file_id, app.cv_file_id);
});

test("follow-up email: for a sent application, without touching the first CV", async () => {
  const { cookie } = await signIn(OWNER);
  const engine = { authorization: "Bearer engine-key" };
  const { users } = await (await call("GET", "/api/engine/users", { headers: engine })).json();
  await call("PUT", `/api/engine/users/${users[0].id}/applications`, { headers: engine,
    body: [{ id: "job9", status: "approved", title: "QA Lead", company: "Zeta" }] });
  await call("PATCH", "/api/applications/job9", { cookie, body: { status: "sent" } });
  let app = (await (await call("GET", "/api/applications", { cookie })).json()).applications.find((a) => a.id === "job9");
  assert.equal(app.applied_on, new Date().toISOString().slice(0, 10));
  await call("POST", "/api/requests", { cookie, body: { kind: "job_followup", target: "job9", note: "short and polite" } });
  const r = (await (await call("GET", "/api/engine/requests", { headers: engine })).json()).requests.find((x) => x.target === "job9");
  assert.equal(r.kind, "job_followup");
  assert.equal(r.followup_note, "short and polite");
  sent = [];
  await call("PUT", `/api/engine/requests/${r.id}`, { headers: engine, body: { mail: { to: "hr@zeta.test", subject: "Following up", body: "Hi" } } });
  app = (await (await call("GET", "/api/applications", { cookie })).json()).applications.find((a) => a.id === "job9");
  assert.equal(app.followup_state, "ready");
  assert.equal(app.followup_mail.subject, "Following up");
  assert.equal(app.status, "sent");
  assert.equal(app.history, undefined);
  assert.match(sent.find((m) => m.url.endsWith("/sendMessage")).body.text, /follow-up email for QA Lead – Zeta/);
  await call("PATCH", "/api/applications/job9", { cookie, body: { followup_sent: true } });
  app = (await (await call("GET", "/api/applications", { cookie })).json()).applications.find((a) => a.id === "job9");
  assert.ok(app.followup_sent_on);
});

test("postings found taken down: marked, Telegram label, a message for approved ones; approving asks for a check", async () => {
  const { cookie } = await signIn(OWNER);
  const engine = { authorization: "Bearer engine-key" };
  const { users } = await (await call("GET", "/api/engine/users", { headers: engine })).json();
  const ref = { telegram: { chat_id: OWNER, message_id: 91 } };
  await call("PUT", `/api/engine/users/${users[0].id}/applications`, { headers: engine, body: [
    { id: "gone1", status: "approved", title: "QA Engineer", company: "Acme", refs: ref },
    { id: "gone2", status: "pending", title: "Tester", company: "Beta", refs: ref },
    { id: "up1", status: "pending", title: "QA", company: "Gamma" }] });
  sent = [];
  const r = await call("PUT", `/api/engine/users/${users[0].id}/checks`, { headers: engine, body: [
    { id: "gone1", open_checked_at: "2026-11-06T09:00:00Z", closed_on: "2026-11-06" },
    { id: "gone2", open_checked_at: "2026-11-06T09:00:00Z", closed_on: "2026-11-06" },
    { id: "up1", open_checked_at: "2026-11-06T09:00:00Z" }, { id: "not-mine", closed_on: "2026-11-06" }] });
  assert.equal((await r.json()).closed, 2);
  const apps = (await (await call("GET", "/api/applications", { cookie })).json()).applications;
  assert.equal(apps.find((a) => a.id === "gone1").closed_on, "2026-11-06");
  assert.equal(apps.find((a) => a.id === "gone1").status, "closed"); // goes to the archive tab
  assert.equal(apps.find((a) => a.id === "gone2").status, "closed");
  assert.equal(apps.find((a) => a.id === "up1").closed_on, undefined);
  assert.equal(apps.find((a) => a.id === "up1").open_checked_at, "2026-11-06T09:00:00Z");
  const labels = sent.filter((m) => m.url.endsWith("/editMessageReplyMarkup")).map((m) => m.body.reply_markup.inline_keyboard[0][0].text);
  assert.deepEqual(labels, ["⚠️ Posting taken down", "⚠️ Posting taken down"]);
  const notes = sent.filter((m) => m.url.endsWith("/sendMessage"));
  assert.equal(notes.length, 1); // only the approved one; a pending one just gets its label
  assert.match(notes[0].body.text, /QA Engineer – Acme/);
});

test("approving a posting in Telegram asks the scheduler for a quick 'is it still up' check", async () => {
  await signIn(OWNER);
  const engine = { authorization: "Bearer engine-key" };
  const { users } = await (await call("GET", "/api/engine/users", { headers: engine })).json();
  await call("PUT", `/api/engine/users/${users[0].id}/applications`, { headers: engine, body: [{ id: "chk1", status: "pending", title: "QA", company: "Acme" }] });
  const asked = [];
  env.SCHEDULER = { fetch: async (url, init) => { asked.push(JSON.parse(init.body)); return new Response("{}"); } };
  await tap(OWNER, "approve:chk1");
  await tap(OWNER, "skip:chk1"); // already handled: no second check
  delete env.SCHEDULER;
  assert.deepEqual(asked, [{ check: true }]);
});

test("search everything for me: limits from the admin page, the scheduler is asked, the search reports back", async () => {
  const { cookie } = await signIn(OWNER);
  const engine = { authorization: "Bearer engine-key" };
  assert.equal((await call("POST", "/api/search-all", { cookie })).status, 400); // nothing to search for yet
  await call("PUT", "/api/me/settings", { cookie, body: { searches: [{ id: "s1" }] } });
  const asked = [];
  env.SCHEDULER = { fetch: async (url, init) => { asked.push(JSON.parse(init.body)); return new Response("{}"); } };
  let r = await (await call("POST", "/api/search-all", { cookie })).json();
  assert.equal(r.state, "waiting");
  assert.equal(r.count_today, 1);
  assert.deepEqual(asked, [{ search_all: true }]);
  assert.equal((await call("POST", "/api/search-all", { cookie })).status, 429); // already waiting
  assert.equal((await (await call("GET", "/api/engine/due", { headers: engine })).json()).due, true);
  const { users, send } = await (await call("GET", "/api/engine/search-all", { headers: engine })).json();
  assert.equal(users.length, 1);
  assert.equal(send, 15);
  await call("PUT", `/api/engine/search-all/${users[0]}`, { headers: engine, body: { state: "done", result: { found: 40, sent: 15, waiting: 25 } } });
  r = await (await call("GET", "/api/search-all", { cookie })).json();
  assert.equal(r.state, "done");
  assert.equal(r.result.sent, 15);
  assert.equal(r.blocked, "cooldown"); // 15 minutes between two
  assert.ok(r.next_at);
  const res = await call("POST", "/api/search-all", { cookie });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, "cooldown");
  // the admin changes the limits: no pause, but only one a day
  await call("PUT", "/api/admin/settings", { cookie, body: { search_all_cooldown_min: 0, search_all_per_day: 1 } });
  assert.equal((await (await call("GET", "/api/search-all", { cookie })).json()).blocked, "limit_day");
  assert.equal((await call("PUT", "/api/admin/settings", { cookie, body: { search_all_per_day: -1 } })).status, 400);
  delete env.SCHEDULER;
});

test("the posting archive: only new postings are written, read in pages, old ones dropped, and the safety", async () => {
  const { cookie } = await signIn(OWNER);
  const engine = { authorization: "Bearer engine-key" };
  await call("PUT", "/api/engine/pool", { headers: engine, body: [{ id: "p1", source: "x", title: "QA" }, { id: "p2", source: "x", title: "Dev" }] });
  const { missing } = await (await call("POST", "/api/engine/pool/known", { headers: engine, body: { ids: ["p1", "p3"] } })).json();
  assert.deepEqual(missing, ["p3"]);
  env.DB.raw.prepare("UPDATE pool SET first_seen = '2020-01-01T00:00:00Z' WHERE id = 'p2'").run();
  const page = await (await call("GET", "/api/engine/pool?limit=1", { headers: engine })).json();
  assert.deepEqual([page.postings.map((p) => p.id), page.next], [["p1"], "p1"]);
  sent = [];
  let state = await (await call("POST", "/api/engine/pool/cleanup", { headers: engine })).json();
  assert.equal(state.deleted, 1);
  assert.equal(state.rows, 1);
  assert.equal(state.days, 45);
  assert.equal(sent.length, 0);
  // 360 MB: over the 350 MB alert – the period goes to 30 days and the admin hears about it, once
  env.DB.fakeSize = 360 * 1024 * 1024;
  state = await (await call("POST", "/api/engine/pool/cleanup", { headers: engine })).json();
  assert.equal(state.days, 30);
  assert.equal(state.level, 1);
  assert.match(sent.find((m) => m.url.endsWith("/sendMessage")).body.text, /360 MB.*30 dana/);
  sent = [];
  await call("POST", "/api/engine/pool/cleanup", { headers: engine });
  assert.equal(sent.length, 0);
  // 50 MB more: the next step, 21 days
  env.DB.fakeSize = 405 * 1024 * 1024;
  state = await (await call("POST", "/api/engine/pool/cleanup", { headers: engine })).json();
  assert.equal(state.days, 21);
  assert.equal(sent.length, 1);
  const admin = await (await call("GET", "/api/admin/pool", { cookie })).json();
  assert.equal(admin.settings.pool_days, 21);
  env.DB.fakeSize = undefined;
});

test("privacy: the search works only for people who accepted the notice; export has their data and only theirs", async () => {
  const { cookie: admin } = await signIn(OWNER);
  const engine = { authorization: "Bearer engine-key" };
  const { code } = await (await call("POST", "/api/admin/invites", { cookie: admin, body: { note: "friend" } })).json();
  const friend = await signIn(2002, code, false);
  let me = await (await call("GET", "/api/me", { cookie: friend.cookie })).json();
  assert.equal(me.consent_at, "");
  assert.equal(me.privacy_version, PRIVACY_VERSION);
  let { users } = await (await call("GET", "/api/engine/users", { headers: engine })).json();
  assert.equal(users.length, 1); // only the owner
  assert.equal((await call("POST", "/api/me/consent", { cookie: friend.cookie, body: { version: "1999-01-01" } })).status, 400);
  await call("POST", "/api/me/consent", { cookie: friend.cookie, body: { version: PRIVACY_VERSION } });
  me = await (await call("GET", "/api/me", { cookie: friend.cookie })).json();
  assert.equal(me.consent_version, PRIVACY_VERSION);
  ({ users } = await (await call("GET", "/api/engine/users", { headers: engine })).json());
  assert.equal(users.length, 2);

  await call("PUT", "/api/me/settings", { cookie: friend.cookie, body: { language: "sr", searches: [{ id: "s1" }] } });
  await call("PUT", `/api/engine/users/${me.id}/applications`, { headers: engine, body: [{ id: "j1", status: "pending", title: "QA", company: "Acme" }] });
  await call("PUT", `/api/engine/users/${users.find((u) => u.id !== me.id).id}/applications`, { headers: engine,
    body: [{ id: "j2", status: "pending", title: "Owner's job", company: "Other" }] });
  const up = await call("POST", "/api/files", { cookie: friend.cookie, body: { name: "cv.pdf", data: Buffer.from("%PDF friend").toString("base64") } });
  assert.equal(up.status, 200);
  const data = await (await call("GET", "/api/me/export", { cookie: friend.cookie })).json();
  assert.equal(data.account.id, me.id);
  assert.equal(data.account.identities[0].subject, "2002");
  assert.equal(data.settings.language, "sr");
  assert.deepEqual(data.applications.map((a) => a.title), ["QA"]);
  assert.deepEqual(data.files.map((f) => f.name), ["cv.pdf"]);
  assert.equal(JSON.stringify(data).includes("Owner's job"), false);
  assert.equal(JSON.stringify(data).includes("id_hash"), false);
});

test("privacy: deleting the account removes everything tied to it; the last admin can't", async () => {
  const { cookie: admin } = await signIn(OWNER);
  const { code } = await (await call("POST", "/api/admin/invites", { cookie: admin, body: { note: "friend" } })).json();
  const friend = await signIn(2002, code);
  const me = await (await call("GET", "/api/me", { cookie: friend.cookie })).json();
  await call("POST", "/api/files", { cookie: friend.cookie, body: { name: "cv.pdf", data: Buffer.from("%PDF").toString("base64") } });
  await call("PUT", `/api/engine/users/${me.id}/applications`, { headers: { authorization: "Bearer engine-key" }, body: [{ id: "j1", status: "pending" }] });
  assert.equal((await call("DELETE", "/api/me", { cookie: friend.cookie, body: {} })).status, 400); // needs the confirmation
  const res = await call("DELETE", "/api/me", { cookie: friend.cookie, body: { confirm: "DELETE" } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await call("GET", "/api/me", { cookie: friend.cookie })).status, 401);
  for (const table of ["users", "identities", "sessions", "applications", "files", "user_files", "user_agencies", "requests", "search_all"]) {
    const col = table === "users" ? "id" : "user_id";
    assert.equal(env.DB.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(me.id).n, 0, table);
  }
  assert.equal(env.DB.raw.prepare("SELECT used_by FROM invites WHERE code = ?").get(code).used_by, "deleted");
  const last = await call("DELETE", "/api/me", { cookie: admin, body: { confirm: "DELETE" } });
  assert.equal(last.status, 400);
  assert.equal((await last.json()).error, "last_admin");
});

test("signing in by sending the site's 6-digit code to the bot (for apps that don't send /start)", async () => {
  const start = await (await call("POST", "/api/auth/telegram/start", { body: {} })).json();
  assert.match(start.chat_code, /^\d{6}$/);
  sent = [];
  await webhook(OWNER, "/start");
  assert.match(sent.at(-1).body.text, /6-digit code/);
  await webhook(OWNER, "000000");
  assert.match(sent.at(-1).body.text, /no sign-in with this code/);
  await webhook(OWNER, `${start.chat_code.slice(0, 3)} ${start.chat_code.slice(3)}`); // with the space the site shows
  const choices = buttons(sent.at(-1));
  assert.equal(choices.length, 5);
  // the same code can't be used again by someone else to grab this sign-in
  await webhook(2002, start.chat_code);
  assert.match(sent.at(-1).body.text, /no sign-in with this code/);
  await tap(OWNER, choices.find((d) => d.endsWith(`:${start.match}`)));
  assert.equal((await call("POST", "/api/auth/poll", { body: { token: start.token } })).status, 200);
});

test("a username changed in Telegram follows on the account: from any tap or message, and when the Account page asks", async () => {
  const { cookie } = await signIn(OWNER);
  const label = async () => (await (await call("GET", "/api/me", { cookie })).json()).identities[0].label;
  assert.equal(await label(), `@user${OWNER}`);
  await call("POST", "/api/telegram", { headers: { "x-telegram-bot-api-secret-token": SECRET },
    body: { update_id: 7, callback_query: { id: "q", from: { id: OWNER, username: "renamed" }, data: "noop" } } });
  assert.equal(await label(), "@renamed");
  // the person removed their username: Telegram's answer has only the name
  globalThis.fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    const result = url.endsWith("/getChat") ? { id: OWNER, first_name: "Ana", last_name: "Anić", type: "private" } : { message_id: 1 };
    return new Response(JSON.stringify({ ok: true, result }));
  };
  const r = await (await call("POST", "/api/me/identities/refresh", { cookie })).json();
  assert.equal(r.identities[0].label, "Ana Anić");
  assert.equal(await label(), "Ana Anić");
});

test("the owner hears on Telegram when someone else asks for a CV; not for their own requests", async () => {
  const { cookie: admin } = await signIn(OWNER);
  const engine = { authorization: "Bearer engine-key" };
  const { code } = await (await call("POST", "/api/admin/invites", { cookie: admin, body: { note: "friend" } })).json();
  const friend = await signIn(2002, code);
  await call("PUT", "/api/me/settings", { cookie: friend.cookie, body: { name: "Marko" } });
  const me = await (await call("GET", "/api/me", { cookie: friend.cookie })).json();
  await call("PUT", `/api/engine/users/${me.id}/applications`, { headers: engine, body: [{ id: "f1", status: "approved", title: "QA", company: "Acme" }] });
  sent = [];
  await call("POST", "/api/requests", { cookie: friend.cookie, body: { kind: "job_cv", target: "f1", note: "" } });
  const msg = sent.find((m) => m.url.endsWith("/sendMessage"));
  assert.equal(String(msg.body.chat_id), String(OWNER));
  assert.match(msg.body.text, /Novi zahtev.*CV za oglas[\s\S]*Marko[\s\S]*QA – Acme/);
  sent = [];
  await call("POST", "/api/requests", { cookie: admin, body: { kind: "agency_mail", target: "own:x" } });
  assert.equal(sent.filter((m) => m.url.endsWith("/sendMessage")).length, 0);
});

test("the catalog's 'how it fits' line is only for the owner", async () => {
  const { cookie: admin } = await signIn(OWNER);
  await call("PUT", "/api/engine/agencies", { headers: { authorization: "Bearer engine-key" },
    body: [{ id: "a1", name: "Agency One", odgovara: "Good for QA", sta_rade: "Recruiting" }] });
  const { code } = await (await call("POST", "/api/admin/invites", { cookie: admin, body: { note: "friend" } })).json();
  const friend = await signIn(2002, code);
  const forOwner = (await (await call("GET", "/api/agencies", { cookie: admin })).json()).catalog[0];
  const forFriend = (await (await call("GET", "/api/agencies", { cookie: friend.cookie })).json()).catalog[0];
  assert.equal(forOwner.odgovara, "Good for QA");
  assert.equal(forFriend.odgovara, undefined);
  assert.equal(forFriend.sta_rade, "Recruiting");
});

test("admin messages go to the group where the owner sent /admin; others can't move them; leaving the group undoes it", async () => {
  const { cookie: admin } = await signIn(OWNER);
  const engine = { authorization: "Bearer engine-key" };
  const group = (from, text) => call("POST", "/api/telegram", { headers: { "x-telegram-bot-api-secret-token": SECRET },
    body: { update_id: 3, message: { message_id: 9, from: { id: from }, chat: { id: -100555, type: "supergroup", title: "Admin" }, text } } });
  await group(2002, "/admin"); // not the owner: nothing changes
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM app_settings WHERE key = 'admin_chat'").get().n, 0);
  await group(OWNER, "/admin@job_alerts_notify_bot");
  const { code } = await (await call("POST", "/api/admin/invites", { cookie: admin, body: { note: "friend" } })).json();
  const friend = await signIn(2002, code);
  const me = await (await call("GET", "/api/me", { cookie: friend.cookie })).json();
  await call("PUT", `/api/engine/users/${me.id}/applications`, { headers: engine, body: [{ id: "g1", status: "approved", title: "QA", company: "Acme" }] });
  sent = [];
  await call("POST", "/api/requests", { cookie: friend.cookie, body: { kind: "job_cv", target: "g1" } });
  assert.equal(sent.find((m) => m.url.endsWith("/sendMessage")).body.chat_id, -100555);
  // the bot is removed from the group: back to the private chat
  await call("POST", "/api/telegram", { headers: { "x-telegram-bot-api-secret-token": SECRET },
    body: { update_id: 4, my_chat_member: { chat: { id: -100555, type: "supergroup" }, new_chat_member: { status: "left" } } } });
  sent = [];
  await call("POST", "/api/requests", { cookie: friend.cookie, body: { kind: "job_cv", target: "g1", change: "shorter" } });
  assert.equal(String(sent.find((m) => m.url.endsWith("/sendMessage")).body.chat_id), String(OWNER));
});

test("on a remembered browser the numbers go to Telegram by themselves; 'send again' works, a few times an hour", async () => {
  const first = await tappedSignIn(OWNER);
  const done = await call("POST", "/api/auth/confirm", { body: { token: first.start.token, yes: true } });
  const device = done.headers.getSetCookie()[1].match(/^device=([\w-]+)/)[1];
  const onDevice = { cookie: `device=${device}` };
  sent = [];
  const start = await (await call("POST", "/api/auth/telegram/start", { body: {}, headers: onDevice })).json();
  assert.equal(start.known, true);
  assert.equal(start.pushed, true);
  const msg = sent.find((m) => m.url.endsWith("/sendMessage"));
  assert.equal(msg.body.chat_id, OWNER);
  assert.ok(buttons(msg).some((d) => d.endsWith(`:${start.match}`)));
  // send again: works twice more this hour, then it's limited
  assert.equal((await call("POST", "/api/auth/resend", { body: { token: start.token }, headers: onDevice })).status, 200);
  assert.equal((await call("POST", "/api/auth/resend", { body: { token: start.token }, headers: onDevice })).status, 200);
  const limited = await call("POST", "/api/auth/resend", { body: { token: start.token }, headers: onDevice });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error, "too_many_pushes");
  // tapping the number still signs in straight away on this browser
  await tap(OWNER, buttons(sent.filter((m) => m.url.endsWith("/sendMessage")).at(-1)).find((d) => d.endsWith(`:${start.match}`)));
  assert.equal((await (await call("POST", "/api/auth/poll", { body: { token: start.token }, headers: onDevice })).json()).ok, true);
  // a browser nobody signed in on: nothing is sent, and "send again" has nowhere to go
  sent = [];
  const fresh = await (await call("POST", "/api/auth/telegram/start", { body: {} })).json();
  assert.deepEqual([fresh.known, fresh.pushed, sent.length], [false, false, 0]);
  assert.equal((await call("POST", "/api/auth/resend", { body: { token: fresh.token } })).status, 400);
});

test("the owner's tools can put a file on an account (engine key only)", async () => {
  const { cookie } = await signIn(OWNER);
  const me = await (await call("GET", "/api/me", { cookie })).json();
  const data = Buffer.from("%PDF old cv").toString("base64");
  assert.equal((await call("PUT", `/api/engine/users/${me.id}/files`, { body: { name: "cv.pdf", data } })).status, 403);
  const r = await (await call("PUT", `/api/engine/users/${me.id}/files`, { headers: { authorization: "Bearer engine-key" },
    body: { name: "cv.pdf", data, kind: "cv" } })).json();
  assert.equal(r.made_by, "tailored");
  const files = (await (await call("GET", "/api/files", { cookie })).json()).files;
  assert.deepEqual(files.map((f) => f.id), [r.id]);
});

test("security: no webhook without a secret; one address can't block sign-in for all; code guessing is limited", async () => {
  delete env.TELEGRAM_WEBHOOK_SECRET;
  const forged = await call("POST", "/api/telegram", { headers: { "x-telegram-bot-api-secret-token": "-" }, body: { update_id: 1 } });
  assert.equal(forged.status, 403);
  env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  const from = (ip) => ({ headers: { "cf-connecting-ip": ip }, body: {} });
  for (let i = 0; i < 10; i++) assert.equal((await call("POST", "/api/auth/telegram/start", from("10.0.0.1"))).status, 200);
  assert.equal((await call("POST", "/api/auth/telegram/start", from("10.0.0.1"))).status, 429);
  assert.equal((await call("POST", "/api/auth/telegram/start", from("10.0.0.2"))).status, 200); // someone else still can
  for (let i = 0; i < 10; i++) await webhook(5555, String(100000 + i));
  sent = [];
  await webhook(5555, "123456");
  assert.match(sent.at(-1).body.text, /Too many codes/);
});

test("security: settings the forms can't produce are refused", async () => {
  const { cookie } = await signIn(OWNER);
  for (const body of [{ schedule: { timezone: "x" } }, { schedule: { interval_hours: 0.01 } }, { schedule: { active_from: "25:00" } },
    { language: "xx" }, { country: "ZZ" }, { max_messages_per_run: 500 }, { searches: "all" }, { dealbreakers: { language: "maybe" } }]) {
    assert.equal((await call("PUT", "/api/me/settings", { cookie, body })).status, 400, JSON.stringify(body));
  }
  assert.equal((await call("PUT", "/api/me/settings", { cookie, body: { schedule: { interval_hours: 3, active_from: "07:30", active_to: "21:00" } } })).status, 200);
  assert.equal((await call("GET", "/api/files/%E0", { cookie })).status, 400); // a broken path is answered, not a crash page
});

test("a card the person deleted in Telegram comes back when its status changes, and the CV note answers it", async () => {
  const { cookie } = await signIn(OWNER);
  const engine = { authorization: "Bearer engine-key" };
  const { users } = await (await call("GET", "/api/engine/users", { headers: engine })).json();
  await call("PUT", `/api/engine/users/${users[0].id}/applications`, { headers: engine, body: [
    { id: "j1", status: "approved", title: "QA Engineer", company: "Acme", url: "https://jobs.test/1",
      refs: { telegram: { chat_id: OWNER, message_id: 42, html: "🆕 <b>QA Engineer</b> – Acme (card as sent)" } } },
    { id: "j2", status: "approved", title: "Tester", company: "Beta", source: "Board", location: "Beograd", score: 6,
      url: "https://jobs.test/2", company_url: "https://beta.test/careers", refs: { telegram: { chat_id: OWNER, message_id: 43 } } }] });
  // Telegram: messages 42 and 43 were deleted by the person; new ones get 500, 501, ...
  const deleted = new Set([42, 43]);
  let next = 500;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, body });
    if (url.endsWith("/editMessageReplyMarkup") && deleted.has(body.message_id)) {
      return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: message to edit not found" }));
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: next++ } }));
  };
  sent = [];
  await call("PATCH", "/api/applications/j1", { cookie, body: { status: "sent" } });
  const card = sent.find((m) => m.url.endsWith("/sendMessage"));
  assert.equal(card.body.text, "🆕 <b>QA Engineer</b> – Acme (card as sent)"); // the very card the search sent
  assert.equal(card.body.reply_markup.inline_keyboard[0][0].text, "📨 Applied");
  let apps = (await (await call("GET", "/api/applications", { cookie })).json()).applications;
  assert.equal(apps.find((a) => a.id === "j1").refs.telegram.message_id, 500);
  sent = [];
  await call("PATCH", "/api/applications/j1", { cookie, body: { status: "interview" } }); // it's there now: just relabelled
  assert.deepEqual(sent.map((m) => m.url.split("/").at(-1)), ["editMessageReplyMarkup"]);
  assert.equal(sent[0].body.message_id, 500);

  // a CV made for a posting whose card is gone: the card comes back (a short one when the old text wasn't kept),
  // then the note answers it, so it's clear which posting it is about
  await call("POST", "/api/requests", { cookie, body: { kind: "job_cv", target: "j2" } });
  const { requests } = await (await call("GET", "/api/engine/requests", { headers: engine })).json();
  sent = [];
  await call("PUT", `/api/engine/requests/${requests[0].id}`, { headers: engine, body: {
    file: { name: "cv.pdf", data: Buffer.from("%PDF cv").toString("base64") } } });
  const [again, note] = sent.filter((m) => m.url.endsWith("/sendMessage"));
  assert.match(again.body.text, /<b>Tester<\/b> – Beta \(Board\)/);
  assert.match(again.body.text, /href="https:\/\/jobs.test\/2"/);
  assert.match(again.body.text, /href="https:\/\/beta.test\/careers"/);
  assert.equal(again.body.reply_markup.inline_keyboard[0][0].text, "📄 CV ready");
  assert.match(note.body.text, /Ready: your CV for Tester – Beta/);
  assert.equal(note.body.reply_parameters.message_id, (await (await call("GET", "/api/applications", { cookie })).json())
    .applications.find((a) => a.id === "j2").refs.telegram.message_id);

  // a posting moved to the archive isn't brought back
  deleted.add(500);
  sent = [];
  await call("PATCH", "/api/applications/j1", { cookie, body: { status: "rejected" } });
  assert.deepEqual(sent.map((m) => m.url.split("/").at(-1)), ["editMessageReplyMarkup"]);
});
