// Signing in with Telegram. The bot reaches the person in one of two ways:
//   - the site's link to the bot carries the login token; pressing Start answers it (first time, or any time)
//   - someone who already has an account types their @username on the site; the bot writes to them directly
// Either way the bot shows a few numbers to pick from (the right one is on the site) and a fallback code.
import brand from "../brand.gen.js";
import { call, sendMessage } from "../telegram_api.js";
import { nowIso } from "../util.js";

export const id = "telegram";

// link: the web page (works everywhere); app_link: opens the Telegram app directly when it is installed
export function instructions(env, token) {
  return { link: `https://t.me/${brand.bot_username}?start=${token}`,
           app_link: `tg://resolve?domain=${brand.bot_username}&start=${token}` };
}

export const isOwner = (env, subject) => Boolean(env.OWNER_TELEGRAM_ID) && String(env.OWNER_TELEGRAM_ID) === String(subject);

const label = (from) => (from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(" "));

// the account's Telegram chat, for notifications; kept in the user's settings
export async function remember(db, userId, contact) {
  if (!contact?.chat_id) return;
  const row = await db.prepare("SELECT settings FROM users WHERE id = ?").bind(userId).first();
  const settings = JSON.parse(row?.settings || "{}");
  settings.channels = { ...(settings.channels || {}), telegram: { chat_id: contact.chat_id, linked_at: nowIso() } };
  await db.prepare("UPDATE users SET settings = ? WHERE id = ?").bind(JSON.stringify(settings), userId).run();
}

async function deliver(env, chatId, offer) {
  const text = `🔐 <b>${brand.name}</b>\n\n` +
    "Signing in? Tap the number you see on the site.\nPrijavljuješ se? Dodirni broj koji vidiš na sajtu.\n\n" +
    `Or type this code / Ili upiši kod: <code>${offer.code}</code>\n\n` +
    "Not you? Don't tap anything – it expires in 10 minutes.\nNisi ti? Ne diraj ništa – ističe za 10 minuta.";
  await call(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML",
    reply_markup: { inline_keyboard: [offer.choices.map((n) => ({ text: n, callback_data: `l:${offer.rid}:${n}` }))] } });
}

// "/start <token>" from the bot's webhook
export async function onStart(env, db, message, token, reach) {
  const offer = await reach(db, { token }, message.from.id, label(message.from), { chat_id: message.chat.id });
  if (offer) return deliver(env, message.chat.id, offer);
  await sendMessage(env, message.chat.id,
    `⌛ ${brand.name}: this sign-in has expired – start again on the site. / Prijava je istekla – kreni ponovo na sajtu.`);
}

// "@username" typed on the site by someone who already has an account
export async function push(env, db, req, username, { reach, maxPerHour }) {
  const wanted = `@${String(username).replace(/^@/, "").trim()}`.toLowerCase();
  const who = await db.prepare("SELECT i.subject, u.settings FROM identities i JOIN users u ON u.id = i.user_id " +
    "WHERE i.provider = 'telegram' AND lower(i.label) = ? AND u.active = 1").bind(wanted).first();
  const chat = who && JSON.parse(who.settings || "{}").channels?.telegram?.chat_id;
  if (!chat) return false;
  const recent = await db.prepare("SELECT COUNT(*) AS n FROM login_requests WHERE subject = ? AND created_at > ?")
    .bind(String(who.subject), nowIso(Date.now() - 3600_000)).first();
  if (recent.n >= maxPerHour) return false; // nobody gets to flood someone's chat with sign-in prompts
  const offer = await reach(db, { rid: req.rid }, who.subject, wanted, { chat_id: chat });
  if (offer) await deliver(env, chat, offer);
  return Boolean(offer);
}

// a tapped number: tell the person what happened and take the buttons away
export async function onButton(env, db, query, approve) {
  const [, rid, number] = String(query.data || "").split(":");
  const result = await approve(db, id, rid, query.from.id, number);
  const say = {
    ok: "✅ Signed in – you can go back to the site. / Prijavljen si – vrati se na sajt.",
    wrong: "❌ Wrong number – this sign-in is cancelled. Start again on the site. / Pogrešan broj – prijava je otkazana.",
    not_you: "This sign-in isn't yours. / Ova prijava nije tvoja.",
    expired: "⌛ This sign-in has expired. / Prijava je istekla.",
  }[result];
  await call(env, "answerCallbackQuery", { callback_query_id: query.id, text: say });
  if (query.message && result !== "not_you") {
    await call(env, "editMessageText", { chat_id: query.message.chat.id, message_id: query.message.message_id,
      text: `🔐 ${brand.name}\n\n${say}` });
  }
}
