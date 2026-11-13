// A tap on a job card's button in Telegram ("approve:<posting id>", "skip:<posting id>"): the status changes in the
// database right away and the buttons turn into a label, in the user's language.
import { call, sendMessage } from "./telegram_api.js";
import { nowIso, parse } from "./util.js";

const LABELS = {
  en: { approved: "✅ Approved – CV to do", ready: "📄 CV ready", sent: "📨 Applied", test: "📝 Test", interview: "🗣 Interview",
    offer: "🎉 Offer", rejected: "❌ Rejected", skipped: "❌ Skipped", no_reply: "🔇 No reply",
    approve: "✅ Approve", skip: "❌ Skip", gone: "This posting is no longer in your list.", done: "Already handled.",
    closed: "⚠️ Posting taken down", closed_msg: "⚠️ {what} has been taken down by the site – no point applying any more.",
    score: "Match", posting: "Posting", company_site: "On the company's site", moved: "↓ This card was sent again further down.",
    noted: "📝 Saved as a note on {what} – you'll see it on the site, under Applications.",
    not_a_card: "📝 Replies are saved as notes only on a posting's card. Reply to the card of the posting you mean." },
  sr: { approved: "✅ Odobreno – čeka CV", ready: "📄 CV spreman", sent: "📨 Poslato", test: "📝 Test", interview: "🗣 Intervju",
    offer: "🎉 Ponuda", rejected: "❌ Odbijeno", skipped: "❌ Preskočeno", no_reply: "🔇 Bez odgovora",
    approve: "✅ Odobri", skip: "❌ Preskoči", gone: "Ovog oglasa više nema na tvojoj listi.", done: "Već je obrađeno.",
    closed: "⚠️ Oglas skinut", closed_msg: "⚠️ Oglas {what} je skinut sa sajta – prijava više nema smisla.",
    score: "Poklapanje", posting: "Oglas", company_site: "Na sajtu firme", moved: "↓ Ova kartica je poslata ponovo niže.",
    noted: "📝 Zapisano kao beleška na prijavi {what} – vidiš je na sajtu, u Prijavama.",
    not_a_card: "📝 Kao beleška se čuva samo odgovor na karticu oglasa. Odgovori na karticu oglasa na koji misliš." },
};

// the buttons under a posting's message, for its status: Approve/Skip while pending, otherwise a label
const STILL_WAITING = ["pending", "approved", "ready", "closed"];
function markup(app, words) {
  if (app.closed_on && STILL_WAITING.includes(app.status)) return { inline_keyboard: [[{ text: words.closed, callback_data: "noop" }]] };
  if (app.status === "pending") {
    return { inline_keyboard: [[{ text: words.approve, callback_data: `approve:${app.id}` }, { text: words.skip, callback_data: `skip:${app.id}` }]] };
  }
  return { inline_keyboard: [[{ text: words[app.status] || app.status, callback_data: "noop" }]] };
}

// statuses whose card is worth sending again after the person deleted it; the archive ones aren't
const BRING_BACK = ["pending", "approved", "ready", "sent", "test", "interview", "offer"];
const esc = (v) => String(v ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);

// the card as the search sent it; applications from before it was kept get a short one from what they have
function cardHtml(app, words) {
  if (app.refs?.telegram?.html) return app.refs.telegram.html;
  const lines = [`🆕 <b>${esc(app.title)}</b> – ${esc(app.company || "?")}${app.source ? ` (${esc(app.source)})` : ""}`];
  if (app.location) lines.push(`📍 ${esc(app.location)}`);
  if (app.score) lines.push(`🎯 ${esc(words.score)}: ${esc(app.score)}/10`);
  lines.push("");
  if (app.url) lines.push(`🔗 <a href="${esc(app.url)}">${esc(words.posting)}</a>`);
  if (app.company_url && app.company_url !== app.url) lines.push(`🏢 <a href="${esc(app.company_url)}">${esc(words.company_site)}</a>`);
  return lines.join("\n");
}

// a status changed on the site: the Telegram card shows it too. Telegram doesn't tell a bot that someone deleted
// a message, but editing a deleted one fails with "message to edit not found": then the card is sent again (for
// postings still in play) and its new message id kept. Returns the card's {chat_id, message_id}, or null.
export async function relabel(env, app, language, db = null, userId = "") {
  const ref = app.refs?.telegram;
  if (!ref?.chat_id || !ref?.message_id || !env.TELEGRAM_BOT_TOKEN) return null;
  const words = LABELS[language] || LABELS.en;
  const r = await call(env, "editMessageReplyMarkup", { chat_id: ref.chat_id, message_id: ref.message_id,
    reply_markup: markup(app, words) }).catch(() => null);
  const gone = r && !r.ok && /message to edit not found|message_id_invalid/i.test(r.description || "");
  if (!gone) return ref; // edited, unchanged ("message is not modified"), or Telegram unreachable: leave it be
  if (!db || !BRING_BACK.includes(app.status)) return null;
  const sent = await call(env, "sendMessage", { chat_id: ref.chat_id, text: cardHtml(app, words), parse_mode: "HTML",
    disable_web_page_preview: true, reply_markup: markup(app, words) }).catch(() => null);
  if (!sent?.ok) return null;
  app.refs.telegram = { ...ref, message_id: sent.result.message_id };
  await db.prepare("UPDATE applications SET data = json_set(data, '$.refs.telegram.message_id', ?) WHERE user_id = ? AND id = ?")
    .bind(sent.result.message_id, userId, app.id).run();
  return app.refs.telegram;
}
// "send it to me again" from the site: a fresh copy of the card at the bottom of the chat, with its current status.
// Telegram never tells a bot that someone cleared the chat on their side, so this is the person's call. The old
// message is deleted if Telegram still allows it (48 hours), otherwise it stays as it is.
export async function resendCard(env, db, userId, app, language) {
  const ref = app.refs?.telegram;
  if (!ref?.chat_id || !env.TELEGRAM_BOT_TOKEN) return null;
  const words = LABELS[language] || LABELS.en;
  const sent = await call(env, "sendMessage", { chat_id: ref.chat_id, text: cardHtml(app, words), parse_mode: "HTML",
    disable_web_page_preview: true, reply_markup: markup(app, words) });
  if (!sent?.ok) return null;
  if (ref.message_id) {
    // older than 48 hours it can't be deleted: it then says where the card went, without buttons
    const del = await call(env, "deleteMessage", { chat_id: ref.chat_id, message_id: ref.message_id }).catch(() => null);
    if (!del?.ok) {
      await call(env, "editMessageText", { chat_id: ref.chat_id, message_id: ref.message_id, text: words.moved }).catch(() => {});
    }
  }
  app.refs.telegram = { ...ref, message_id: sent.result.message_id };
  await db.prepare("UPDATE applications SET data = json_set(data, '$.refs.telegram.message_id', ?) WHERE user_id = ? AND id = ?")
    .bind(sent.result.message_id, userId, app.id).run();
  return app.refs.telegram;
}

const ACTIONS = { approve: "approved", skip: "skipped" };

// the search found postings gone: their messages get a label, and the person hears about the ones they approved
export async function postingsClosed(env, apps, settings) {
  const words = LABELS[settings.language] || LABELS.en;
  for (const app of apps) {
    await relabel(env, app, settings.language);
    const chat = settings.channels?.telegram?.chat_id;
    if (chat && ["approved", "ready"].includes(app.closed_from || app.status)) {
      const what = `„${app.title} – ${app.company}”`.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]);
      await sendMessage(env, chat, words.closed_msg.replace("{what}", what)).catch(() => {});
    }
  }
}

export async function cardAction(env, db, query) {
  const m = String(query.data || "").match(/^(approve|skip):([\w-]{1,40})$/);
  if (!m) return call(env, "answerCallbackQuery", { callback_query_id: query.id });
  const user = await db.prepare("SELECT u.id, u.settings FROM identities i JOIN users u ON u.id = i.user_id " +
    "WHERE i.provider = 'telegram' AND i.subject = ? AND u.active = 1").bind(String(query.from.id)).first();
  const words = LABELS[parse(user?.settings, {}).language] || LABELS.en;
  const row = user && await db.prepare("SELECT data FROM applications WHERE user_id = ? AND id = ?").bind(user.id, m[2]).first();
  if (!row) return call(env, "answerCallbackQuery", { callback_query_id: query.id, text: words.gone });
  const app = parse(row.data, {});
  if (app.status !== "pending") return call(env, "answerCallbackQuery", { callback_query_id: query.id, text: words.done });
  app.status = ACTIONS[m[1]];
  app.decided_at = nowIso();
  await db.prepare("UPDATE applications SET data = ?, updated_at = ? WHERE user_id = ? AND id = ?")
    .bind(JSON.stringify(app), nowIso(), user.id, m[2]).run();
  await call(env, "answerCallbackQuery", { callback_query_id: query.id, text: words[app.status] });
  // an approved posting is checked at once: it may have been taken down since it was found
  if (app.status === "approved" && env.SCHEDULER && env.ENGINE_KEY) {
    await env.SCHEDULER.fetch("https://scheduler/run", { method: "POST", headers: { authorization: `Bearer ${env.ENGINE_KEY}` },
      body: JSON.stringify({ check: true }) }).catch(() => {});
  }
  if (query.message) {
    await call(env, "editMessageReplyMarkup", { chat_id: query.message.chat.id, message_id: query.message.message_id,
      reply_markup: markup(app, words) });
  }
}

// a reply to a job's card in the chat (a question, "they called me", ...): kept as a note on that application,
// where the person and whoever makes their CV will see it; the bot says where it went
export async function cardReply(env, db, msg) {
  const user = await db.prepare("SELECT u.id, u.settings FROM identities i JOIN users u ON u.id = i.user_id " +
    "WHERE i.provider = 'telegram' AND i.subject = ? AND u.active = 1").bind(String(msg.from?.id)).first();
  if (!user) return;
  const words = LABELS[parse(user.settings, {}).language] || LABELS.en;
  const row = await db.prepare("SELECT id, data FROM applications WHERE user_id = ? AND " +
    "json_extract(data, '$.refs.telegram.message_id') = ? AND json_extract(data, '$.refs.telegram.chat_id') = ?")
    .bind(user.id, msg.reply_to_message.message_id, msg.chat.id).first();
  const answer = (text) => call(env, "sendMessage", { chat_id: msg.chat.id, text,
    reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } }).catch(() => {});
  if (!row) return answer(words.not_a_card);
  const app = parse(row.data, {});
  app.notes = [...(app.notes || []), { at: nowIso(), text: String(msg.text).trim().slice(0, 2000), via: "telegram" }];
  await db.prepare("UPDATE applications SET data = ?, updated_at = ? WHERE user_id = ? AND id = ?")
    .bind(JSON.stringify(app), nowIso(), user.id, row.id).run();
  return answer(words.noted.replace("{what}", `„${app.title} – ${app.company}”`));
}
