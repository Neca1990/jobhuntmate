-- Files people keep on their account (CVs, cover letters), stored in the database itself (no file storage needed).
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'cv',            -- 'cv' | 'letter' | 'other'
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  made_by TEXT NOT NULL DEFAULT 'user',       -- 'user' (uploaded) | 'tailored' (made for a request)
  created_at TEXT NOT NULL
);
CREATE INDEX files_user ON files(user_id, created_at);

-- Recruitment agencies: one shared catalog (kept here only, never in the repository) ...
CREATE TABLE agencies (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,                         -- JSON: name, type, site, email, how to apply, summary, sources...
  active INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
-- ... and each user's own dealings with them (status, notes, the email), plus agencies they add themselves
CREATE TABLE user_agencies (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agency_id TEXT NOT NULL,                    -- a catalog id, or 'own:<id>' for one the user added
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, agency_id)
);

-- Work asked of the owner (or, later, the Claude API): a tailored CV and email for an agency or a job
CREATE TABLE requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                         -- 'agency_mail' | 'job_cv'
  target TEXT NOT NULL,                       -- agency id or application id
  status TEXT NOT NULL DEFAULT 'waiting',     -- 'waiting' | 'done' | 'cancelled'
  note TEXT NOT NULL DEFAULT '',
  file_id TEXT NOT NULL DEFAULT '',           -- the CV to start from
  created_at TEXT NOT NULL,
  done_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX requests_status ON requests(status, created_at);
