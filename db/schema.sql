PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  login         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL,
  department    TEXT,
  position      TEXT,
  uyushma_id    INTEGER,
  loyiha_id     INTEGER,
  manager_id    INTEGER,
  phone         TEXT,
  email         TEXT,
  lang          TEXT NOT NULL DEFAULT 'uz',
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_seen     TEXT,
  telegram_id   INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS uyushmalar (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  short_name    TEXT NOT NULL,
  sector        TEXT NOT NULL,
  region        TEXT NOT NULL,
  members_count INTEGER NOT NULL DEFAULT 0,
  head_user_id  INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loyihalar (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'FAOL',
  progress   INTEGER NOT NULL DEFAULT 0,
  budget     REAL NOT NULL DEFAULT 0,
  owner_id   INTEGER,
  uyushma_id INTEGER,
  deadline   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT,
  from_user_id   INTEGER NOT NULL REFERENCES users(id),
  to_user_id     INTEGER NOT NULL REFERENCES users(id),
  to_department  TEXT,
  priority       TEXT NOT NULL DEFAULT 'ORTA',
  status         TEXT NOT NULL DEFAULT 'YANGI',
  deadline       TEXT,
  loyiha_id      INTEGER,
  uyushma_id     INTEGER,
  result_comment TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  accepted_at    TEXT,
  submitted_at   TEXT,
  closed_at      TEXT
);

CREATE TABLE IF NOT EXISTS task_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  action     TEXT NOT NULL,
  comment    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id INTEGER NOT NULL REFERENCES users(id),
  to_user_id   INTEGER NOT NULL REFERENCES users(id),
  body         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  read_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_to    ON tasks(to_user_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_from  ON tasks(from_user_id, status);
CREATE INDEX IF NOT EXISTS idx_msg_pair    ON messages(from_user_id, to_user_id, id);
CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, id);
