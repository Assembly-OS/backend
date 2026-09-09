-- Схема ASSEMBLY OS для PostgreSQL.
--
-- Порт со SQLite. Отличия, которые пришлось решить, и почему именно так:
--
--   INTEGER PRIMARY KEY AUTOINCREMENT → GENERATED ALWAYS AS IDENTITY.
--   Это стандартный SQL и, в отличие от SERIAL, не оставляет за собой
--   отдельную последовательность, права на которую надо выдавать вручную.
--
--   Времена остаются TEXT в формате 'YYYY-MM-DD HH:MM:SS' UTC.
--   Соблазн перейти на timestamptz велик, но весь код — сравнения, сортировки,
--   формат в интерфейсе, перевод в ташкентское время — построен вокруг этой
--   строки. Менять тип и логику одновременно значит не понять, что сломалось.
--   Перевод типов — отдельная работа после переезда.
--
--   datetime('now') → to_char(now() AT TIME ZONE 'UTC', ...) с тем же видом.
--
--   COLLATE NOCASE в запросах заменён на ILIKE, а уникальность логина —
--   на уникальный индекс по lower(login): в Postgres регистронезависимость
--   задаётся индексом, а не свойством колонки.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
  -- BIGINT, не INTEGER: в SQLite INTEGER 64-битный, а Telegram выдаёт
  -- идентификаторы больше 2^31 с 2021 года — в int4 они не помещаются и
  -- переносятся ошибкой «out of range», останавливая весь перенос.
  telegram_id   BIGINT,
  created_at    TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE TABLE IF NOT EXISTS uyushmalar (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          TEXT NOT NULL,
  short_name    TEXT NOT NULL,
  sector        TEXT NOT NULL,
  region        TEXT NOT NULL,
  members_count INTEGER NOT NULL DEFAULT 0,
  head_user_id  INTEGER,
  created_at    TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE TABLE IF NOT EXISTS loyihalar (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'FAOL',
  progress   INTEGER NOT NULL DEFAULT 0,
  -- DOUBLE PRECISION, а не REAL: REAL в Postgres — четыре байта, точных
  -- цифр в нём около семи. Бюджет в сумах это число больше, и REAL округлил
  -- бы его молча, при переносе и в каждом SUM(budget) после.
  budget     DOUBLE PRECISION NOT NULL DEFAULT 0,
  owner_id   INTEGER,
  uyushma_id INTEGER,
  deadline   TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  -- Added after the first release: the public site's blurb and the number
  -- it lists each project under, so the panel and assembly.uz can be read
  -- side by side.
  description TEXT,
  site_no     INTEGER
);

CREATE TABLE IF NOT EXISTS tasks (
  id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
  created_at     TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  accepted_at    TEXT,
  submitted_at   TEXT,
  closed_at      TEXT
);

CREATE TABLE IF NOT EXISTS task_events (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  action     TEXT NOT NULL,
  comment    TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

-- A named conversation with more than two people in it.
CREATE TABLE IF NOT EXISTS chat_groups (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title      TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id  INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id),
  joined_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
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
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
  created_at   TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  read_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_to    ON tasks(to_user_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_from  ON tasks(from_user_id, status);
CREATE INDEX IF NOT EXISTS idx_msg_pair    ON messages(from_user_id, to_user_id, id);
CREATE INDEX IF NOT EXISTS idx_gm_user     ON group_members(user_id, group_id);
-- В SQLite этот индекс жил в db.ts: там схема выполнялась против таблицы,
-- в которой group_id ещё не было, и индекс ждал миграцию. Здесь group_id
-- объявлен в CREATE TABLE выше, ждать нечего — а db.ts после переезда не
-- останется, и без этой строки индекса не будет вовсе.
CREATE INDEX IF NOT EXISTS idx_msg_group   ON messages(group_id, id);
CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id, id);

-- ------------------------------------------------------------------
-- AI agents (TZ §10). One row per orchestrated run, one per proposal.
-- ------------------------------------------------------------------

-- Every agent run, whatever its outcome — this is the audit log the spec
-- requires at the end of the pattern, written even when the policy check
-- refuses to let the agent start.
CREATE TABLE IF NOT EXISTS agent_runs (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
  created_at  TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  -- Who submitted the material, and what it was, once runs stopped being
  -- anonymous.
  owner_user_id INTEGER,
  source_kind   TEXT,
  source_ref    TEXT
);

-- What the agent proposes to do. Nothing here has happened yet: an action
-- that needs approval waits in 'pending' until a human decides.
CREATE TABLE IF NOT EXISTS agent_proposals (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
  created_at  TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  -- The reviewer, once proposals started being approved by a person.
  owner_user_id INTEGER
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_at   ON agent_runs(id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_prop_stat ON agent_proposals(status, id DESC);

-- Who submitted the source and what it was. A run started from the admin
-- panel has no owner; one started by a department head does, and that person
-- is the one allowed to approve its proposals.
CREATE TABLE IF NOT EXISTS meetings (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title        TEXT NOT NULL,
  owner_id     INTEGER NOT NULL REFERENCES users(id),
  -- Storage key of the recording, when one was kept. Transcript is the
  -- analysed artefact; the audio is evidence.
  audio_key    TEXT,
  duration     INTEGER,
  transcript   TEXT NOT NULL,
  -- Recognition language: 'uz-UZ' | 'ru-RU' | 'en-US'.
  lang         TEXT NOT NULL DEFAULT 'uz-UZ',
  created_at   TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  -- Meetings became CRM records as well as recordings: who was there, where
  -- it happened, and what was agreed to do next.
  company_id     INTEGER,
  held_at        TEXT,
  place          TEXT,
  participants   TEXT,
  responsible_id INTEGER,
  description    TEXT,
  next_steps     TEXT,
  updated_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_meetings_owner ON meetings(owner_id, id DESC);

-- A meeting while it is still happening. The recorder uploads the audio it has
-- so far every minute; the server transcribes only the part it has not heard
-- yet (`offset_ms`) and keeps a running picture of the meeting in `state`.
-- Separate from `meetings` on purpose: this row exists before anyone knows
-- whether the recording will be worth keeping, and is deleted when it is not.
CREATE TABLE IF NOT EXISTS meeting_live (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
  created_at   TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  updated_at   TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE INDEX IF NOT EXISTS idx_live_owner ON meeting_live(owner_id, id DESC);

-- What the platform remembers between meetings.
--
-- Not a transcript archive: one row is one durable fact worth carrying into
-- the next meeting — a commitment somebody made, a decision that still binds,
-- a risk that was raised. Fed back into later analyses so the agent knows what
-- was already agreed instead of re-deriving it from scratch every time.
CREATE TABLE IF NOT EXISTS meeting_memory (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  meeting_id   INTEGER REFERENCES meetings(id),
  -- Who or what the fact is about, as written in the meeting.
  subject      TEXT NOT NULL,
  fact         TEXT NOT NULL,
  -- 'qaror' | 'majburiyat' | 'xavf' | 'kontekst'
  kind         TEXT NOT NULL DEFAULT 'kontekst',
  created_at   TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
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
  created_at  TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
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
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Matched case-insensitively so "Uzum" and "UZUM" are one company.
  name        TEXT NOT NULL UNIQUE,
  sector      TEXT,
  first_seen  TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  last_seen   TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  -- The CRM grew onto this table after it was first written as a bare
  -- directory of names. Everything below arrived by migration, and the
  -- queries in lib/crm.ts read every one of them.
  description     TEXT,
  industry        TEXT,
  direction       TEXT,
  services        TEXT,
  country         TEXT,
  city            TEXT,
  address         TEXT,
  website         TEXT,
  email           TEXT,
  phone           TEXT,
  head_name       TEXT,
  head_position   TEXT,
  status          TEXT NOT NULL DEFAULT 'POTENTIAL',
  started_at      TEXT,
  last_contact_at TEXT,
  next_contact_at TEXT,
  notes           TEXT,
  owner_user_id   INTEGER,
  created_at      TEXT,
  updated_at      TEXT
);

-- What was said about a company in one meeting, in all three languages.
CREATE TABLE IF NOT EXISTS partner_notes (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  partner_id  INTEGER NOT NULL REFERENCES partners(id),
  meeting_id  INTEGER REFERENCES meetings(id),
  -- 'muhokama' discussed | 'taklif' we offered | 'ehtiyoj' they need
  -- | 'kelishuv' agreed | 'xavf' risk
  kind        TEXT NOT NULL DEFAULT 'muhokama',
  uz          TEXT NOT NULL,
  ru          TEXT NOT NULL,
  en          TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

-- What to propose next, and why. The answer to "what can I offer them?" —
-- including a match across two companies that never met each other.
CREATE TABLE IF NOT EXISTS partner_ideas (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
  created_at   TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE INDEX IF NOT EXISTS idx_partner_notes ON partner_notes(partner_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_partner_ideas ON partner_ideas(status, id DESC);

/* ==================================================================
   CRM: компании, контакты, совещания, договорённости, напоминания
   ================================================================== */

-- Companies. The table is still called `partners` because the AI intake has
-- been writing to it since before the CRM existed; renaming it would break
-- that path for no gain. Everything below is the full company card.
CREATE TABLE IF NOT EXISTS company_fields_marker (id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY);

CREATE TABLE IF NOT EXISTS contacts (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
  created_at    TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  updated_at    TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id, is_head DESC);

-- One thing somebody committed to in a meeting.
--
-- Deliberately separate from `tasks`. A task is internal work assigned to a
-- colleague through the platform's own workflow; an agreement is what the
-- Assembly and a company undertook together, and it survives whether or not
-- anyone turned it into a task. The two are linked, not merged.
CREATE TABLE IF NOT EXISTS agreements (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
  created_at    TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  done_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_agree_company  ON agreements(company_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_agree_deadline ON agreements(status, deadline);
CREATE INDEX IF NOT EXISTS idx_agree_owner    ON agreements(owner_user_id, status);

CREATE TABLE IF NOT EXISTS reminders (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  agreement_id  INTEGER REFERENCES agreements(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  -- 'YYYY-MM-DD HH:MM:SS' UTC, like every other instant in this database.
  remind_at     TEXT NOT NULL,
  -- 'deadline' | 'followup' | 'manual'
  kind          TEXT NOT NULL DEFAULT 'deadline',
  -- PENDING | SENT | DISMISSED
  status        TEXT NOT NULL DEFAULT 'PENDING',
  message       TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
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
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
  created_at  TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
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
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'user' | 'assistant'
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  -- The source links shown under an answer, as JSON. Stored rather than
  -- recomputed: they are what the model actually cited at the time.
  refs        TEXT NOT NULL DEFAULT '[]',
  created_at  TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE INDEX IF NOT EXISTS idx_assistant_msgs ON assistant_messages(user_id, id);


-- Логин уникален без учёта регистра: в SQLite это делал COLLATE NOCASE
-- на колонке, здесь — индекс. Без него «Rais» и «rais» стали бы двумя людьми.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_login_ci ON users (lower(login));

-- То же для названия компании: в SQLite это делал COLLATE NOCASE на колонке.
-- Без индекса «Uzum» и «UZUM» становятся двумя компаниями — тем более что
-- lib/agents/partners.ts ищет по lower(name) и вставляет, если не нашёл,
-- а с несколькими писателями это уже гонка.
CREATE UNIQUE INDEX IF NOT EXISTS idx_partners_name_ci ON partners (lower(name));

-- Колонки, добавленные миграциями поверх исходной схемы.
-- Собраны сравнением с рабочей базой, а не по истории правок:
-- база — источник истины о том, что в ней на самом деле есть.
ALTER TABLE loyihalar ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE loyihalar ADD COLUMN IF NOT EXISTS site_no INTEGER;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS owner_user_id INTEGER;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS source_kind TEXT;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS source_ref TEXT;
ALTER TABLE agent_proposals ADD COLUMN IF NOT EXISTS owner_user_id INTEGER;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS company_id INTEGER;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS held_at TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS place TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS participants TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS responsible_id INTEGER;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS next_steps TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS updated_at TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS industry TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS direction TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS services TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS head_name TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS head_position TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'POTENTIAL';
ALTER TABLE partners ADD COLUMN IF NOT EXISTS started_at TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS last_contact_at TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS next_contact_at TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS owner_user_id INTEGER;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS created_at TEXT;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS updated_at TEXT;

-- =====================================================================
-- Ko'p bosqichli topshiriq — цепочка этапов.
--
-- Одна работа, которую по очереди держат несколько человек. Строка tasks
-- ВСЕГДА отражает ТЕКУЩИЙ этап, поэтому ни один существующий запрос по
-- tasks не меняет смысла: кто держит поручение сейчас — тот и лежит в
-- tasks.to_user_id, как лежал вчера.
--
-- Цена этого решения названа прямо: to_user_id/status/времена живут
-- одновременно в двух таблицах, и БД инвариант проверить не может. Он
-- держится тем, что пишет в них одна транзакция (pg.ts::tx).
-- =====================================================================
CREATE TABLE IF NOT EXISTS task_stages (
  id               INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id          INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,                 -- 1..N, порядок в очереди
  to_user_id       INTEGER NOT NULL REFERENCES users(id),
  -- Кто утверждает ИМЕННО этот этап. NULL = автор поручения (сегодняшнее
  -- поведение). Заполнено = исполнитель следующего этапа проверяет за
  -- предыдущим, и тогда approve не требует захода автора, а return
  -- возвращает работу назад её исполнителю.
  reviewer_user_id INTEGER REFERENCES users(id),
  instruction      TEXT,                             -- что делает этот человек; NULL = общее описание
  -- 'KUTMOQDA' (очередь не дошла) либо любое значение TaskStatus.
  -- KUTMOQDA живёт только здесь и никогда не попадает в tasks.status,
  -- поэтому TASK_STATUSES, statusTone, фильтры и словари не трогаются.
  status           TEXT NOT NULL DEFAULT 'KUTMOQDA',
  result_comment   TEXT,                             -- что сдал ЭТОТ исполнитель
  accepted_at      TEXT,
  submitted_at     TEXT,
  closed_at        TEXT,
  created_at       TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  UNIQUE (task_id, position)
);

CREATE INDEX IF NOT EXISTS idx_stages_user ON task_stages(to_user_id, status);
CREATE INDEX IF NOT EXISTS idx_stages_task ON task_stages(task_id, position);

-- Зеркало текущего этапа на самой задаче. DEFAULT 1 — обычное поручение
-- это цепочка длиной один, а не «цепочки нет».
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS current_stage    INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS stage_count      INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS reviewer_user_id INTEGER REFERENCES users(id);

-- Weekly work and long work are different things to look at, and the platform
-- had one list for both: a project running to December sat among errands due
-- on Friday, and neither could be read without the other in the way.
-- 'HAFTALIK' is the default because most assignments are the short kind, and
-- because every row that already exists is one of those.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'HAFTALIK';

-- The result a person hands in can now carry a file. The key is the same
-- storage key an attachment uses; the name is kept so a download has one.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS result_file_key  TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS result_file_name TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS result_file_size INTEGER;
ALTER TABLE task_stages ADD COLUMN IF NOT EXISTS result_file_key  TEXT;
ALTER TABLE task_stages ADD COLUMN IF NOT EXISTS result_file_name TEXT;
ALTER TABLE task_stages ADD COLUMN IF NOT EXISTS result_file_size INTEGER;

-- К какому этапу относится запись журнала. NULL у всех старых строк —
-- отчёты обязаны читать её через COALESCE, см. reports.ts.
ALTER TABLE task_events ADD COLUMN IF NOT EXISTS stage_position INTEGER;

-- Бэкфилл: каждое существующее поручение становится цепочкой длиной 1,
-- копируя собственное состояние. UPDATE по tasks не выполняется вообще —
-- DEFAULT 1 у новых колонок уже даёт current_stage = stage_count = 1.
-- ON CONFLICT, а не WHERE NOT EXISTS: файл выполняется при старте каждого
-- процесса (веб и бот стартуют независимо), и проверка-перед-вставкой на
-- двух одновременных стартах дала бы дубли.
INSERT INTO task_stages (task_id, position, to_user_id, reviewer_user_id, status,
                         result_comment, accepted_at, submitted_at, closed_at, created_at)
SELECT id, 1, to_user_id, NULL, status,
       result_comment, accepted_at, submitted_at, closed_at, created_at
  FROM tasks
ON CONFLICT (task_id, position) DO NOTHING;

-- =====================================================================
-- Projects as workspaces, and the threads that carry their history.
--
-- `loyihalar` was a register: a code, a budget, a percentage, a row on the
-- public site. What it could never answer is the question people walk up to
-- a colleague to ask — "what is happening with Smart City?" — because the
-- answer lived in four heads, a chat, and somebody's notebook.
--
-- A project is now a workspace holding one thread per counterpart: UNIDO, LG,
-- Huawei, the ministry, the internal team. A thread is a work journal, not a
-- conversation: entries are dated records of what happened, appended in the
-- order it happened, and read months later to rebuild the whole relationship.
--
-- The distinction from `messages` is deliberate and load-bearing. Chat is
-- people talking; a thread entry is the record that survives them. Chat is
-- read once and scrolled past, so it stores a sent time and nothing else.
-- An entry stores the day the thing HAPPENED, which is often not the day
-- somebody got round to writing it down, and that is the whole difference
-- between a log and a memory.
--
-- Nothing here replaces meetings, agreements or tasks. Those tables keep
-- their meaning and their queries; an entry points at the one it produced,
-- so "we agreed X" is both a line in the story and a row with a deadline.
-- =====================================================================

-- ORTA matches the task default: one priority vocabulary in the platform,
-- not two that need translating at every boundary.
ALTER TABLE loyihalar ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'ORTA';
-- When work actually began, as opposed to when somebody created the row.
ALTER TABLE loyihalar ADD COLUMN IF NOT EXISTS started_at TEXT;
-- Free text on purpose. "Waiting on their legal review" is a real stage and
-- no enum written in advance will contain it.
ALTER TABLE loyihalar ADD COLUMN IF NOT EXISTS stage TEXT;

-- One counterpart inside a project: an organisation, a workstream, or the
-- team itself. Unlimited per project, by design — a programme that touches
-- eleven ministries needs eleven threads and no ceremony to open the twelfth.
CREATE TABLE IF NOT EXISTS project_threads (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES loyihalar(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  -- The CRM company this thread is about, where it is one. Kept nullable and
  -- ON DELETE SET NULL: "Internal team" and "Tender preparation" are threads
  -- with no company, and losing a company must not take its history with it.
  company_id  INTEGER REFERENCES partners(id) ON DELETE SET NULL,
  -- ORG | DIRECTION | INTERNAL. Decides the icon and nothing else; a thread
  -- is a thread.
  kind        TEXT NOT NULL DEFAULT 'ORG',
  -- One line answering "where does this stand right now", written by a person
  -- and shown in the sidebar. Not generated, not derived: the last entry is
  -- frequently a document upload and says nothing about the state of play.
  summary     TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  -- Denormalised so the project page can order and date a sidebar of forty
  -- threads without forty subqueries. Written in the same transaction as the
  -- entry that moves it.
  last_entry_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_threads_project
  ON project_threads(project_id, is_archived, last_entry_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_company ON project_threads(company_id);

-- One dated record in a thread's history.
CREATE TABLE IF NOT EXISTS thread_entries (
  id         INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  thread_id  INTEGER NOT NULL REFERENCES project_threads(id) ON DELETE CASCADE,
  author_id  INTEGER NOT NULL REFERENCES users(id),
  -- NOTE | MEETING | AGREEMENT | FILE | LINK. What kind of record this is,
  -- which is what lets the journal be read as a history rather than a wall.
  kind       TEXT NOT NULL DEFAULT 'NOTE',
  body       TEXT NOT NULL DEFAULT '',
  -- The calendar day the thing happened, in Assembly time. NULL means "the
  -- day it was written", which is the common case; a filled value is somebody
  -- recording Tuesday's meeting on Thursday, and the journal must show
  -- Tuesday or it is not a history.
  occurred_on TEXT,
  -- Marked as worth finding again.
  is_pinned  INTEGER NOT NULL DEFAULT 0,
  -- An attachment, using the same storage key an ordinary attachment uses.
  file_key   TEXT,
  file_name  TEXT,
  file_size  INTEGER,
  link_url   TEXT,
  -- What this entry produced, where it produced something. The entry is the
  -- story; these are the rows that carry a deadline and chase themselves.
  meeting_id   INTEGER REFERENCES meetings(id) ON DELETE SET NULL,
  agreement_id INTEGER REFERENCES agreements(id) ON DELETE SET NULL,
  task_id      INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  edited_at  TEXT,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
);

CREATE INDEX IF NOT EXISTS idx_entries_thread ON thread_entries(thread_id, id);
CREATE INDEX IF NOT EXISTS idx_entries_pinned
  ON thread_entries(thread_id, id DESC) WHERE is_pinned = 1;

-- Who is working this thread. The project's owner answers for the whole of
-- it; these are the people to notify about this counterpart in particular.
CREATE TABLE IF NOT EXISTS thread_members (
  thread_id  INTEGER NOT NULL REFERENCES project_threads(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')),
  PRIMARY KEY (thread_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_thread_members_user ON thread_members(user_id);

-- The project a meeting, an agreement or a task belongs to. All nullable and
-- staying nullable: plenty of each is a one-off that belongs to a company and
-- to no project, and forcing them into one would be a lie. `tasks.loyiha_id`
-- has existed since the first release.
ALTER TABLE meetings   ADD COLUMN IF NOT EXISTS loyiha_id INTEGER;
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS loyiha_id INTEGER;
ALTER TABLE agreements ADD COLUMN IF NOT EXISTS thread_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_meetings_project ON meetings(loyiha_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_agree_project    ON agreements(loyiha_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_project    ON tasks(loyiha_id, id DESC);

-- When the assignee first opened the assignment.
--
-- The one genuinely new state in the task lifecycle: accepted and refused
-- were always recorded, but "he has not even looked at it yet" was not — and
-- that is what a manager most needs when nothing has happened, because it
-- separates somebody ignoring the work from somebody who never saw it.
-- NULL on every existing row, and NULL is meaningful: not seen.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS seen_at TEXT;

-- The words inside an attached document.
--
-- Without this a file was a dead end in the memory: the journal showed
-- "ifc-meeting-transcript.pdf, 74 KB" and the assistant, asked what the
-- transcript said, correctly answered that the records contained no such
-- thing. The file was in the archive; its contents were nowhere.
--
-- Filled once, when the file is uploaded, and read by both the search and the
-- assistant from then on. NULL means it has not been read — an old row, an
-- unreadable format, or an extraction that failed — and the assistant is told
-- that rather than being left to assume the document was empty.
ALTER TABLE thread_entries ADD COLUMN IF NOT EXISTS file_text TEXT;
