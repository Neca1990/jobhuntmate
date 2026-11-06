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
