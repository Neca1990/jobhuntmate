-- Accounts are separate from the ways of signing in (identities), so new sign-in methods (Google, email code)
-- are added without touching accounts or their data.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',          -- 'user' | 'admin'
  active INTEGER NOT NULL DEFAULT 1,
  settings TEXT NOT NULL DEFAULT '{}'         -- JSON: language, country, searches, schedule, channels, profile...
);

CREATE TABLE identities (
  provider TEXT NOT NULL,                     -- 'telegram' now; 'google', 'email' later
  subject TEXT NOT NULL,                      -- the provider's id for the person (Telegram user id, Google sub, email)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',             -- what to show: @username, email address
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX identities_user ON identities(user_id);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,                   -- SHA-256 of the cookie value; the value itself is never stored
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE login_requests (
  token_hash TEXT PRIMARY KEY,                -- SHA-256 of the token the browser holds
  provider TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  invite TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',           -- filled when the person proves who they are (e.g. presses Start in the bot)
  label TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '{}',         -- JSON: how to reach them on that provider (Telegram chat id)
  code_hash TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  used_by TEXT NOT NULL DEFAULT '',
  used_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL                         -- JSON
);
INSERT INTO app_settings (key, value) VALUES
  ('registration', '"invite_only"'),          -- 'invite_only' | 'open'
  ('cv_generator', '"manual"'),               -- 'manual' (the owner asks Claude) | 'claude_api'
  ('api_monthly_cap_usd', '5'),
  ('api_user_monthly_cap_usd', '1'),
  ('login_providers', '["telegram"]');

-- the search engine's per-user files (state, seen, queue) and shared state
CREATE TABLE user_files (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, name)
);

CREATE TABLE applications (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  data TEXT NOT NULL,                         -- JSON (see engine/run.py)
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE global_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE postings (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
