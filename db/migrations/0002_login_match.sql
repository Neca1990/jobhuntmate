-- Sign-in by picking, in Telegram, the number shown on the site (the typed code stays as a fallback).
ALTER TABLE login_requests ADD COLUMN rid TEXT NOT NULL DEFAULT '';          -- public id used in the bot's buttons
ALTER TABLE login_requests ADD COLUMN match TEXT NOT NULL DEFAULT '';        -- the number the site shows
ALTER TABLE login_requests ADD COLUMN approved_at TEXT NOT NULL DEFAULT '';  -- set when the right number is tapped
CREATE INDEX login_requests_rid ON login_requests(rid);
CREATE INDEX login_requests_subject ON login_requests(subject, created_at);
