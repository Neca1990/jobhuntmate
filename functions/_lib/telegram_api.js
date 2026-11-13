// The few Telegram Bot API calls the site itself makes. Tests replace fetch.
export async function call(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json();
}

export const sendMessage = (env, chatId, text) =>
  call(env, "sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true });

// a file (a CV, a cover letter) as a Telegram document; bytes is a Uint8Array
export async function sendDocument(env, chatId, bytes, filename, caption = "", mime = "application/pdf") {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) form.append("caption", caption);
  form.append("document", new Blob([bytes], { type: mime }), filename);
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, { method: "POST", body: form });
  return r.json();
}
