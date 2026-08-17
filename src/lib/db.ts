import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

// Каталог данных задаётся снаружи: в образе это /data — постоянный том,
// смонтированный рядом с /data/uploads. Без переменной база уходит в
// /app/data, то есть в эфемерный слой контейнера: файлы вложений
// переживают перезапуск, а строки в базе — нет. Расхождение состояния
// хуже честного падения.
const DB_DIR =
  process.env.ASSAMBLEYA_DATA_DIR || path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "assambleya.db");
const SCHEMA_PATH = path.join(process.cwd(), "db", "schema.sql");

type Global = typeof globalThis & { __assambleyaDb?: DatabaseSync };

function open(): DatabaseSync {
  if (!fs.existsSync(/* turbopackIgnore: true */ DB_DIR))
    fs.mkdirSync(/* turbopackIgnore: true */ DB_DIR, { recursive: true });
  const database = new DatabaseSync(DB_PATH);

  // node:sqlite does not enable these by default. Set them before any query:
  //  - WAL: concurrent readers never block the single writer.
  //  - foreign_keys: the schema's relationships are actually enforced.
  //  - busy_timeout: a contended write waits instead of throwing SQLITE_BUSY.
  //  - synchronous NORMAL: the safe, fast pairing with WAL.
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
  `);

  database.exec(
    fs.readFileSync(/* turbopackIgnore: true */ SCHEMA_PATH, "utf8"),
  );

  // `CREATE TABLE IF NOT EXISTS` never alters an existing table, so a database
  // seeded before `last_seen` existed needs the column added once. Adding it
  // twice throws "duplicate column name" — safe to ignore.
  try {
    database.exec("ALTER TABLE users ADD COLUMN last_seen TEXT");
  } catch {
    /* column already present */
  }

  // Links a platform account to a Telegram user (set by the bot's /link).
  try {
    database.exec("ALTER TABLE users ADD COLUMN telegram_id INTEGER");
  } catch {
    /* column already present */
  }

  // Chat attachments (photo / voice / file). A database seeded when messages
  // were text-only needs these added one by one — SQLite has no
  // "ADD COLUMN IF NOT EXISTS", and a re-run throws "duplicate column name".
  for (const column of [
    "kind TEXT NOT NULL DEFAULT 'text'",
    "file_name TEXT",
    "file_size INTEGER",
    "file_mime TEXT",
    "file_key TEXT",
    "duration INTEGER",
  ]) {
    try {
      database.exec(`ALTER TABLE messages ADD COLUMN ${column}`);
    } catch {
      /* column already present */
    }
  }

  // Group chats put a second kind of row in `messages`: one addressed to a
  // group rather than a person. That needs `to_user_id` to be nullable and a
  // `group_id` column — and SQLite cannot drop a NOT NULL, so the table is
  // rebuilt once. Guarded on the current shape, so it runs exactly one time.
  const columns = database.prepare("PRAGMA table_info(messages)").all() as {
    name: string;
    notnull: number;
  }[];
  const toUser = columns.find((column) => column.name === "to_user_id");
  const hasGroup = columns.some((column) => column.name === "group_id");

  if (toUser?.notnull === 1 || !hasGroup) {
    // Foreign keys off for the swap: dropping the old table would otherwise
    // trip the references pointing at it. The copy is one transaction, so a
    // crash mid-migration leaves the original intact.
    database.exec("PRAGMA foreign_keys = OFF;");
    database.exec(`
      BEGIN;
      CREATE TABLE messages_rebuilt (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user_id INTEGER NOT NULL REFERENCES users(id),
        to_user_id   INTEGER REFERENCES users(id),
        group_id     INTEGER REFERENCES chat_groups(id) ON DELETE CASCADE,
        body         TEXT NOT NULL,
        kind         TEXT NOT NULL DEFAULT 'text',
        file_name    TEXT,
        file_size    INTEGER,
        file_mime    TEXT,
        file_key     TEXT,
        duration     INTEGER,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        read_at      TEXT
      );
      INSERT INTO messages_rebuilt
        (id, from_user_id, to_user_id, group_id, body, kind,
         file_name, file_size, file_mime, file_key, duration, created_at, read_at)
      SELECT id, from_user_id, to_user_id, NULL, body, kind,
             file_name, file_size, file_mime, file_key, duration, created_at, read_at
        FROM messages;
      DROP TABLE messages;
      ALTER TABLE messages_rebuilt RENAME TO messages;
      COMMIT;
    `);
    database.exec("PRAGMA foreign_keys = ON;");
  }

  // Agent runs gained an owner (the person who submitted the source) and a
  // pointer to that source after the first agents shipped. Same one-by-one
  // ALTER dance as the message columns above.
  for (const [table, column] of [
    ["agent_runs", "owner_user_id INTEGER"],
    ["agent_runs", "source_kind TEXT"],
    ["agent_runs", "source_ref TEXT"],
    ["agent_proposals", "owner_user_id INTEGER"],
    ["meetings", "lang TEXT NOT NULL DEFAULT 'uz-UZ'"],
    ["agent_proposals", "reviewer_user_id INTEGER"],
    ["loyihalar", "description TEXT"],
    ["loyihalar", "site_no INTEGER"],
    ["partners", "description TEXT"],
    ["partners", "industry TEXT"],
    ["partners", "direction TEXT"],
    ["partners", "services TEXT"],
    ["partners", "country TEXT"],
    ["partners", "city TEXT"],
    ["partners", "address TEXT"],
    ["partners", "website TEXT"],
    ["partners", "email TEXT"],
    ["partners", "phone TEXT"],
    ["partners", "head_name TEXT"],
    ["partners", "head_position TEXT"],
    ["partners", "status TEXT NOT NULL DEFAULT 'POTENTIAL'"],
    ["partners", "started_at TEXT"],
    ["partners", "last_contact_at TEXT"],
    ["partners", "next_contact_at TEXT"],
    ["partners", "notes TEXT"],
    ["partners", "owner_user_id INTEGER"],
    ["partners", "created_at TEXT"],
    ["partners", "updated_at TEXT"],
    ["meetings", "company_id INTEGER"],
    ["meetings", "held_at TEXT"],
    ["meetings", "place TEXT"],
    ["meetings", "participants TEXT"],
    ["meetings", "responsible_id INTEGER"],
    ["meetings", "description TEXT"],
    ["meetings", "next_steps TEXT"],
    ["meetings", "updated_at TEXT"],
  ] as const) {
    try {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
    } catch {
      /* column already present */
    }
  }

  // Both indexes are (re)created here rather than in schema.sql: the group one
  // needs the column the migration above adds, and the pair one is dropped
  // along with the old table whenever that migration runs.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_msg_pair  ON messages(from_user_id, to_user_id, id);
    CREATE INDEX IF NOT EXISTS idx_msg_group ON messages(group_id, id);
  `);

  // Fold any leftover write-ahead log back into the main file and truncate it,
  // so a long-lived connection does not let the -wal file grow unbounded.
  database.exec("PRAGMA wal_checkpoint(TRUNCATE);");

  return database;
}

/**
 * One connection per process, parked on globalThis so Next's dev-mode module
 * reloading does not leak a new SQLite handle on every edit.
 */
export function db(): DatabaseSync {
  const g = globalThis as Global;
  if (!g.__assambleyaDb) g.__assambleyaDb = open();
  return g.__assambleyaDb;
}

type Param = string | number | null | bigint | Uint8Array;

/**
 * node:sqlite hands back null-prototype objects, which React refuses to pass
 * from a Server Component to a Client Component. Copy into plain objects once,
 * here, so every caller gets serialisable rows.
 */
function plain<T>(row: unknown): T {
  return { ...(row as object) } as T;
}

export function all<T>(sql: string, ...params: Param[]): T[] {
  return db()
    .prepare(sql)
    .all(...params)
    .map((row) => plain<T>(row));
}

export function get<T>(sql: string, ...params: Param[]): T | undefined {
  const row = db().prepare(sql).get(...params);
  return row === undefined ? undefined : plain<T>(row);
}

export function run(sql: string, ...params: Param[]) {
  return db().prepare(sql).run(...params);
}

/** `YYYY-MM-DD HH:MM:SS` in UTC — the format every timestamp column uses. */
export function now(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}
