import assert from "node:assert/strict";
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
async function signIn(telegramId, invite = "") {
  const start = await (await call("POST", "/api/auth/telegram/start", { body: { invite } })).json();
  await webhook(telegramId, `/start ${start.token}`);
  const code = sent.at(-1).body.text.match(/<code>(\d{6})<\/code>/)?.[1];
  const res = await call("POST", "/api/auth/verify", { body: { token: start.token, code } });
  return { res, cookie: (res.headers.get("set-cookie") || "").split(";")[0], start, code };
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
  const done = await call("POST", "/api/auth/poll", { body: { token: start.token } });
  assert.equal(done.status, 200);
  assert.match(done.headers.get("set-cookie"), /^session=/);
  assert.equal((await call("POST", "/api/auth/poll", { body: { token: start.token } })).status, 400); // used up
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

test("a known @username gets the numbers directly; an unknown one looks the same from outside", async () => {
  await signIn(OWNER); // the owner's account now exists with @user1001
  sent = [];
  const known = await (await call("POST", "/api/auth/telegram/start", { body: { username: "@USER1001" } })).json();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.chat_id, OWNER);
  const unknown = await (await call("POST", "/api/auth/telegram/start", { body: { username: "nobody" } })).json();
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(known).sort(), Object.keys(unknown).sort());
  await tap(OWNER, buttons(sent[0]).find((d) => d.endsWith(`:${known.match}`)));
  assert.equal((await call("POST", "/api/auth/poll", { body: { token: known.token } })).status, 200);
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
