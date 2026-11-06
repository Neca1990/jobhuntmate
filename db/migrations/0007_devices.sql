-- Browsers a sign-in identity has used before. A sign-in answered from Telegram is finished at once only on such a
-- browser; anywhere else the person at the browser first confirms "this is me" (so a code given to someone else
-- can't sign this browser into their account unnoticed). Only a hash of the browser's random id is kept.
CREATE TABLE devices (
  id_hash TEXT NOT NULL,
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  PRIMARY KEY (id_hash, provider, subject)
);
CREATE INDEX devices_subject ON devices(provider, subject);
