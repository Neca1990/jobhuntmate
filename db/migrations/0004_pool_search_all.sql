-- Every posting the search finds, kept for a while (admin setting pool_days, 45 by default) so a person can have
-- all of it searched for them ("search everything for me"), not only what is new. Only public posting text.
CREATE TABLE pool (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  data TEXT NOT NULL                          -- JSON: the posting as the search read it
);
CREATE INDEX pool_first_seen ON pool(first_seen);

-- "search everything for me": the last request of each person, and how many they made today
CREATE TABLE search_all (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'idle',         -- 'idle' | 'waiting' | 'running' | 'done'
  day TEXT NOT NULL DEFAULT '',               -- the day "count" is for (UTC)
  count INTEGER NOT NULL DEFAULT 0,
  last_at TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '{}'           -- JSON: found, sent, waiting
);

INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('search_all_cooldown_min', '15'),          -- minutes between two requests of one person
  ('search_all_per_day', '3'),
  ('search_all_send', '15'),                  -- sent at once; the rest follow with the regular searches
  ('pool_days', '45'),
  ('pool_alert_mb', '350'),                   -- the safety: above this the period shortens and the admin hears
  ('pool_step_mb', '50');                     -- ...and again every this many MB more
