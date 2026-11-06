-- A short code the site shows, which the person sends to the bot as a plain message: signing in works even in
-- Telegram apps that open an existing chat without sending "/start <token>".
ALTER TABLE login_requests ADD COLUMN chat_code TEXT NOT NULL DEFAULT '';
CREATE INDEX login_requests_chat_code ON login_requests(chat_code);
