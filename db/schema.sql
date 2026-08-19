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
  closed_at      TEXT,
  -- Ko'p bosqichli topshiriq: зеркало текущего этапа цепочки.
  -- 1/1 у обычного поручения, поэтому старые строки не меняются.
  current_stage    INTEGER NOT NULL DEFAULT 1,
  stage_count      INTEGER NOT NULL DEFAULT 1,
  reviewer_user_id INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS task_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  action     TEXT NOT NULL,
  comment    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- К какому этапу цепочки относится запись. NULL у всех строк, записанных
  -- до появления этапов, — отчёты читают её через COALESCE.
  stage_position INTEGER
);

-- Этапы поручения: кто держит работу первым, кто вторым, и кто чей этап
-- утверждает. Строка tasks зеркалит текущий этап.
CREATE TABLE IF NOT EXISTS task_stages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id          INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  to_user_id       INTEGER NOT NULL REFERENCES users(id),
  reviewer_user_id INTEGER REFERENCES users(id),
  instruction      TEXT,
  status           TEXT NOT NULL DEFAULT 'KUTMOQDA',
  result_comment   TEXT,
  accepted_at      TEXT,
  submitted_at     TEXT,
  closed_at        TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (task_id, position)
);
CREATE INDEX IF NOT EXISTS idx_stages_user ON task_stages(to_user_id, status);
CREATE INDEX IF NOT EXISTS idx_stages_task ON task_stages(task_id, position);

-- A named conversation with more than two people in it.
CREATE TABLE IF NOT EXISTS chat_groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id  INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id),
  joined_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (group_id, user_id)
);

-- "Read" in a group is per member, so it cannot live on the message row the
-- way `messages.read_at` does for a one-to-one thread. Each member keeps a
-- high-water mark instead.
CREATE TABLE IF NOT EXISTS group_reads (
  group_id     INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, user_id)
);

-- `body` doubles as the caption of an attachment, so it may be empty (never
-- NULL) on a photo/voice/file row. `kind` says which shape the row is; the
-- file_* columns are all NULL when kind = 'text'.
--
-- Exactly one of `to_user_id` / `group_id` is set: the first addresses one
-- colleague, the second a group. Keeping both kinds in one table means
-- attachments, ids and the /api/files route work the same either way.
CREATE TABLE IF NOT EXISTS messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user_id INTEGER NOT NULL REFERENCES users(id),
  to_user_id   INTEGER REFERENCES users(id),
  group_id     INTEGER REFERENCES chat_groups(id) ON DELETE CASCADE,
  body         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'text',
  file_name    TEXT,
  file_size    INTEGER,
  file_mime    TEXT,
  -- Path relative to data/uploads. Never sent to the client: attachments are
  -- fetched by message id through /api/files, which re-checks the reader.
  file_key     TEXT,
  -- Voice length in seconds, as measured by the recorder. NULL otherwise.
  duration     INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  read_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_to    ON tasks(to_user_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_from  ON tasks(from_user_id, status);
CREATE INDEX IF NOT EXISTS idx_msg_pair    ON messages(from_user_id, to_user_id, id);
CREATE INDEX IF NOT EXISTS idx_gm_user     ON group_members(user_id, group_id);
-- idx_msg_group lives in db.ts: on a database created before group chats this
-- file still runs against a `messages` table that has no group_id yet, and the
-- index has to wait until the migration there has added the column.
CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, id);

-- ------------------------------------------------------------------
-- AI agents (TZ §10). One row per orchestrated run, one per proposal.
-- ------------------------------------------------------------------

-- Every agent run, whatever its outcome — this is the audit log the spec
-- requires at the end of the pattern, written even when the policy check
-- refuses to let the agent start.
CREATE TABLE IF NOT EXISTS agent_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent       TEXT NOT NULL,
  -- 'manual' | 'schedule' | 'event'
  trigger     TEXT NOT NULL,
  -- Who set it off: an admin session has no user row, so this may be NULL.
  actor       TEXT NOT NULL,
  -- 'ok' | 'blocked' | 'error'
  status      TEXT NOT NULL,
  -- Why a run was blocked, or what went wrong.
  detail      TEXT,
  -- Rows the agent was allowed to read, and how long the whole run took.
  context_rows INTEGER NOT NULL DEFAULT 0,
  proposals   INTEGER NOT NULL DEFAULT 0,
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  used_model  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What the agent proposes to do. Nothing here has happened yet: an action
-- that needs approval waits in 'pending' until a human decides.
CREATE TABLE IF NOT EXISTS agent_proposals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  agent       TEXT NOT NULL,
  -- The action verb, always one the agent's action scope allows.
  action      TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  -- 'P1'..'P4' — drives the notification policy in TZ §11.1.
  severity    TEXT NOT NULL DEFAULT 'P3',
  -- The entity this concerns, so a reader can follow the citation.
  subject_kind TEXT,
  subject_id   INTEGER,
  -- JSON payload the executor needs. Never executed before approval.
  payload     TEXT,
  -- 'pending' | 'approved' | 'rejected' | 'executed' | 'failed' | 'auto'
  status      TEXT NOT NULL DEFAULT 'pending',
  decided_by  TEXT,
  decided_at  TEXT,
  result      TEXT,
  -- Who must look at this before it takes effect: the head of the proposed
  -- assignee's department. The submitter is the fallback when the department
  -- has no head — a proposal nobody owns is a proposal nobody acts on.
  reviewer_user_id INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_at   ON agent_runs(id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_prop_stat ON agent_proposals(status, id DESC);

-- Who submitted the source and what it was. A run started from the admin
-- panel has no owner; one started by a department head does, and that person
-- is the one allowed to approve its proposals.
CREATE TABLE IF NOT EXISTS meetings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  owner_id     INTEGER NOT NULL REFERENCES users(id),
  -- Storage key of the recording, when one was kept. Transcript is the
  -- analysed artefact; the audio is evidence.
  audio_key    TEXT,
  duration     INTEGER,
  transcript   TEXT NOT NULL,
  -- Recognition language: 'uz-UZ' | 'ru-RU' | 'en-US'.
  lang         TEXT NOT NULL DEFAULT 'uz-UZ',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_meetings_owner ON meetings(owner_id, id DESC);

-- A meeting while it is still happening. The recorder uploads the audio it has
-- so far every minute; the server transcribes only the part it has not heard
-- yet (`offset_ms`) and keeps a running picture of the meeting in `state`.
-- Separate from `meetings` on purpose: this row exists before anyone knows
-- whether the recording will be worth keeping, and is deleted when it is not.
CREATE TABLE IF NOT EXISTS meeting_live (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id     INTEGER NOT NULL REFERENCES users(id),
  title        TEXT NOT NULL,
  lang         TEXT NOT NULL DEFAULT 'uz-UZ',
  audio_key    TEXT,
  -- Milliseconds of audio already transcribed. Whisper resumes from here.
  offset_ms    INTEGER NOT NULL DEFAULT 0,
  transcript   TEXT NOT NULL DEFAULT '',
  -- Characters of `transcript` already shown to the model. Speech arriving in
  -- dribs is held here until there is enough of it to be worth a round.
  analyzed_len INTEGER NOT NULL DEFAULT 0,
  -- JSON: keyPoints, decisions, plan, questions — the live picture.
  state        TEXT,
  rounds       INTEGER NOT NULL DEFAULT 0,
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  tokens_out   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_live_owner ON meeting_live(owner_id, id DESC);

-- What the platform remembers between meetings.
--
-- Not a transcript archive: one row is one durable fact worth carrying into
-- the next meeting — a commitment somebody made, a decision that still binds,
-- a risk that was raised. Fed back into later analyses so the agent knows what
-- was already agreed instead of re-deriving it from scratch every time.
CREATE TABLE IF NOT EXISTS meeting_memory (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id   INTEGER REFERENCES meetings(id),
  -- Who or what the fact is about, as written in the meeting.
  subject      TEXT NOT NULL,
  fact         TEXT NOT NULL,
  -- 'qaror' | 'majburiyat' | 'xavf' | 'kontekst'
  kind         TEXT NOT NULL DEFAULT 'kontekst',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_recent ON meeting_memory(id DESC);

-- What a meeting concluded, written once per language.
--
-- Kept apart from `meetings` (which holds the raw transcript) because this is
-- the part people actually read, and they do not all read it in the same
-- language: the chairman's summary is the same summary in Uzbek, Russian and
-- English, produced together by one analysis rather than translated afterwards.
CREATE TABLE IF NOT EXISTS meeting_conclusions (
  meeting_id  INTEGER NOT NULL REFERENCES meetings(id),
  -- 'uz' | 'ru' | 'en'. Cyrillic Uzbek reads the latin row.
  lang        TEXT NOT NULL,
  summary     TEXT NOT NULL,
  -- JSON arrays of strings, in the same order across languages.
  key_points  TEXT NOT NULL DEFAULT '[]',
  decisions   TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (meeting_id, lang)
);

CREATE INDEX IF NOT EXISTS idx_conclusions_at ON meeting_conclusions(meeting_id DESC);

-- Counterparties the Assembly talks to, and what those talks left behind.
--
-- Meetings are events; a relationship is not. A chairman who sits in four
-- meetings a week cannot hold "what did we already discuss with this company,
-- what did we offer, what did they need" in his head, and the transcript of a
-- meeting six weeks ago is not where he will look for it. These three tables
-- are where he looks: one row per company, its history underneath, and the
-- things worth proposing to it next.
CREATE TABLE IF NOT EXISTS partners (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Matched case-insensitively so "Uzum" and "UZUM" are one company.
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  sector      TEXT,
  first_seen  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What was said about a company in one meeting, in all three languages.
CREATE TABLE IF NOT EXISTS partner_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id  INTEGER NOT NULL REFERENCES partners(id),
  meeting_id  INTEGER REFERENCES meetings(id),
  -- 'muhokama' discussed | 'taklif' we offered | 'ehtiyoj' they need
  -- | 'kelishuv' agreed | 'xavf' risk
  kind        TEXT NOT NULL DEFAULT 'muhokama',
  uz          TEXT NOT NULL,
  ru          TEXT NOT NULL,
  en          TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- What to propose next, and why. The answer to "what can I offer them?" —
-- including a match across two companies that never met each other.
CREATE TABLE IF NOT EXISTS partner_ideas (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id   INTEGER REFERENCES partners(id),
  meeting_id   INTEGER REFERENCES meetings(id),
  -- The other company, when the idea is to introduce two of them.
  match_id     INTEGER REFERENCES partners(id),
  proposal_uz  TEXT NOT NULL,
  proposal_ru  TEXT NOT NULL,
  proposal_en  TEXT NOT NULL,
  why_uz       TEXT NOT NULL DEFAULT '',
  why_ru       TEXT NOT NULL DEFAULT '',
  why_en       TEXT NOT NULL DEFAULT '',
  -- 'yangi' new | 'bajarildi' acted on | 'kerak emas' dismissed
  status       TEXT NOT NULL DEFAULT 'yangi',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_partner_notes ON partner_notes(partner_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_partner_ideas ON partner_ideas(status, id DESC);

/* ==================================================================
   CRM: компании, контакты, совещания, договорённости, напоминания
   ================================================================== */

-- Companies. The table is still called `partners` because the AI intake has
-- been writing to it since before the CRM existed; renaming it would break
-- that path for no gain. Everything below is the full company card.
CREATE TABLE IF NOT EXISTS company_fields_marker (id INTEGER PRIMARY KEY);

CREATE TABLE IF NOT EXISTS contacts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL DEFAULT '',
  position      TEXT,
  phone         TEXT,
  email         TEXT,
  telegram      TEXT,
  -- Exactly one contact per company should carry this; enforced in code,
  -- because SQLite cannot express "at most one true per group".
  is_head       INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id, is_head DESC);

-- One thing somebody committed to in a meeting.
--
-- Deliberately separate from `tasks`. A task is internal work assigned to a
-- colleague through the platform's own workflow; an agreement is what the
-- Assembly and a company undertook together, and it survives whether or not
-- anyone turned it into a task. The two are linked, not merged.
CREATE TABLE IF NOT EXISTS agreements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER REFERENCES partners(id) ON DELETE CASCADE,
  meeting_id    INTEGER REFERENCES meetings(id) ON DELETE SET NULL,
  -- The task raised to carry it out, when one was.
  task_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  description   TEXT NOT NULL,
  -- Who owes it. A staff member where we know them; free text where the
  -- commitment sits with the other side ("Ularning moliya bo'limi").
  owner_user_id INTEGER REFERENCES users(id),
  owner_name    TEXT,
  -- 'YYYY-MM-DD'. Null means the meeting set no date.
  deadline      TEXT,
  -- NEW | IN_PROGRESS | DONE | CANCELLED. "Overdue" is never stored: it is
  -- derived from the deadline at read time, so it can never go stale and
  -- needs no nightly job.
  status        TEXT NOT NULL DEFAULT 'NEW',
  priority      TEXT NOT NULL DEFAULT 'ORTA',
  note          TEXT,
  -- Written by the AI analysis rather than typed by a person.
  source        TEXT NOT NULL DEFAULT 'manual',
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  done_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_agree_company  ON agreements(company_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_agree_deadline ON agreements(status, deadline);
CREATE INDEX IF NOT EXISTS idx_agree_owner    ON agreements(owner_user_id, status);

CREATE TABLE IF NOT EXISTS reminders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  agreement_id  INTEGER REFERENCES agreements(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  -- 'YYYY-MM-DD HH:MM:SS' UTC, like every other instant in this database.
  remind_at     TEXT NOT NULL,
  -- 'deadline' | 'followup' | 'manual'
  kind          TEXT NOT NULL DEFAULT 'deadline',
  -- PENDING | SENT | DISMISSED
  status        TEXT NOT NULL DEFAULT 'PENDING',
  message       TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_remind_due ON reminders(status, remind_at);
CREATE INDEX IF NOT EXISTS idx_remind_user ON reminders(user_id, status, remind_at);

-- In-app notifications.
--
-- Written at the moment something happens to a person — a task lands on them,
-- an agreement they own comes due, a proposal needs their review. Stored rather
-- than derived because the one thing a notification must remember is whether it
-- has been read, and that cannot be computed from the underlying record.
CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'task' | 'reminder' | 'agreement' | 'review' | 'meeting'
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  href        TEXT NOT NULL DEFAULT '/dashboard',
  -- What it is about, so the same event is never announced twice.
  entity      TEXT,
  entity_id   INTEGER,
  read_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at, id DESC);
-- The uniqueness that makes delivery idempotent: one notification per person
-- per thing. A sweep that runs twice writes once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_once
  ON notifications(user_id, kind, entity, entity_id)
  WHERE entity IS NOT NULL;

-- The AI chat, kept so that a refresh does not throw the conversation away.
--
-- Server-side rather than in the browser on purpose: the answers quote what
-- was said in negotiations, and localStorage on a shared office machine would
-- leave one person's questions sitting there for the next person to log in.
-- Here it is scoped to the account, follows them to their phone, and goes
-- when the account goes.
CREATE TABLE IF NOT EXISTS assistant_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'user' | 'assistant'
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  -- The source links shown under an answer, as JSON. Stored rather than
  -- recomputed: they are what the model actually cited at the time.
  refs        TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assistant_msgs ON assistant_messages(user_id, id);
