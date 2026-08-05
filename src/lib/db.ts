import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";

const DB_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "assambleya.db");
const SCHEMA_PATH = path.join(process.cwd(), "db", "schema.sql");

type Global = typeof globalThis & { __assambleyaDb?: DatabaseSync };

function open(): DatabaseSync {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
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

  database.exec(fs.readFileSync(SCHEMA_PATH, "utf8"));

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
