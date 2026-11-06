-- When a person accepted the privacy notice, and which version of it. The search only works for people who have
-- (an empty value means not yet), and a changed notice is accepted again.
ALTER TABLE users ADD COLUMN consent_version TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN consent_at TEXT NOT NULL DEFAULT '';
