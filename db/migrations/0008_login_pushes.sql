-- Sign-in messages the bot sent to someone without them writing first (their remembered browser, their @username,
-- "send it again"): at most a few an hour per account, so nobody can flood someone's chat with sign-in prompts.
CREATE TABLE login_pushes (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX login_pushes_subject ON login_pushes(provider, subject, at);
