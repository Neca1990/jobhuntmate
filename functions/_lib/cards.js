// A tap on a job card's button in Telegram ("approve:<posting id>", "skip:<posting id>"): the status changes in the
// database right away and the buttons turn into a label, in the user's language.
import { call } from "./telegram_api.js";
import { nowIso, parse } from "./util.js";

const LABELS = {
  en: { approved: "✅ Approved – CV to do", ready: "📄 CV ready", sent: "📨 Applied", test: "📝 Test", interview: "🗣 Interview",
    offer: "🎉 Offer", rejected: "❌ Rejected", skipped: "❌ Skipped", no_reply: "🔇 No reply",
    approve: "✅ Approve", skip: "❌ Skip", gone: "This posting is no longer in your list.", done: "Already handled." },
  sr: { approved: "✅ Odobreno – čeka CV", ready: "📄 CV spreman", sent: "📨 Poslato", test: "📝 Test", interview: "🗣 Intervju",
    offer: "🎉 Ponuda", rejected: "❌ Odbijeno", skipped: "❌ Preskočeno", no_reply: "🔇 Bez odgovora",
    approve: "✅ Odobri", skip: "❌ Preskoči", gone: "Ovog oglasa više nema na tvojoj listi.", done: "Već je obrađeno." },
};

// the buttons under a posting's message, for its status: Approve/Skip while pending, otherwise a label
function markup(app, words) {
  if (app.status === "pending") {
    return { inline_keyboard: [[{ text: words.approve, callback_data: `approve:${app.id}` }, { text: words.skip, callback_data: `skip:${app.id}` }]] };
  }
  return { inline_keyboard: [[{ text: words[app.status] || app.status, callback_data: "noop" }]] };
}

// a status changed on the site: the Telegram message shows it too
export async function relabel(env, app, language) {
  const ref = app.refs?.telegram;
  if (!ref?.chat_id || !ref?.message_id || !env.TELEGRAM_BOT_TOKEN) return;
  await call(env, "editMessageReplyMarkup", { chat_id: ref.chat_id, message_id: ref.message_id,
    reply_markup: markup(app, LABELS[language] || LABELS.en) }).catch(() => {}); // a deleted message is fine
}
const ACTIONS = { approve: "approved", skip: "skipped" };

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
  if (query.message) {
    await call(env, "editMessageReplyMarkup", { chat_id: query.message.chat.id, message_id: query.message.message_id,
      reply_markup: markup(app, words) });
  }
}
