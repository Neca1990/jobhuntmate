// Where the owner hears about the site itself (new requests, the database safety): a Telegram group of their own,
// so it stays apart from their job messages. The owner adds the bot to a group and sends /admin there; until then,
// and if the bot is removed from that group, these messages go to the owner's private chat with the bot.
import { call } from "./telegram_api.js";
import { nowIso, parse } from "./util.js";

const KEY = "admin_chat";
const save = (db, value) => db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) " +
  "ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(KEY, JSON.stringify(value)).run();

async function where(env, db) {
  const chat = parse((await db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(KEY).first())?.value, null);
  return chat?.chat_id || env.OWNER_TELEGRAM_ID;
}

export async function notifyAdmin(env, db, html) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.OWNER_TELEGRAM_ID) return;
  const send = (chat_id) => call(env, "sendMessage", { chat_id, text: html, parse_mode: "HTML", disable_web_page_preview: true });
  let r = await send(await where(env, db)).catch(() => null);
  const moved = r?.parameters?.migrate_to_chat_id; // a group that became a supergroup gets a new id
  if (moved) {
    await save(db, { chat_id: moved, at: nowIso() });
    r = await send(moved).catch(() => null);
  }
  if (!r?.ok) await send(env.OWNER_TELEGRAM_ID).catch(() => {}); // the group is gone: the private chat still works
}

// "/admin" in a group, from the owner: this group gets the admin messages; "/admin_off" sends them back to the private chat
export async function onAdminCommand(env, db, msg) {
  const cmd = String(msg?.text || "").match(/^\/(admin|admin_off)(@\w+)?\s*$/)?.[1];
  if (!cmd || !["group", "supergroup"].includes(msg.chat?.type)) return false;
  if (String(msg.from?.id) !== String(env.OWNER_TELEGRAM_ID)) return true; // only the owner decides; others are ignored
  if (cmd === "admin") {
    await save(db, { chat_id: msg.chat.id, title: msg.chat.title || "", at: nowIso() });
    await call(env, "sendMessage", { chat_id: msg.chat.id, text: "✅ This group now gets the admin messages: new CV/email requests and database warnings.\n" +
      "Ova grupa sada prima administratorska obaveštenja: nove zahteve za CV i mejl i upozorenja o bazi.\n\n/admin_off – back to the private chat / nazad u privatni razgovor" });
  } else {
    await db.prepare("DELETE FROM app_settings WHERE key = ?").bind(KEY).run();
    await call(env, "sendMessage", { chat_id: msg.chat.id, text: "↩️ Admin messages go to the private chat again. / Obaveštenja ponovo idu u privatni razgovor." });
  }
  return true;
}

// the bot was removed from the admin group: back to the private chat
export async function onMembership(db, update) {
  const m = update.my_chat_member;
  if (!m || !["left", "kicked"].includes(m.new_chat_member?.status)) return;
  const chat = parse((await db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(KEY).first())?.value, null);
  if (String(chat?.chat_id) === String(m.chat.id)) await db.prepare("DELETE FROM app_settings WHERE key = ?").bind(KEY).run();
}
