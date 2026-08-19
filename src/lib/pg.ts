import fs from "node:fs";
import path from "node:path";
import { Pool, types } from "pg";

/**
 * PostgreSQL access layer.
 *
 * Replaces the `node:sqlite` one, and the reason is the move to a server: a
 * file on somebody's laptop cannot be read by two processes on two machines,
 * and the platform, the bot and the reminder sweep are already three.
 *
 * **Queries keep writing `?`.** Postgres numbers its parameters `$1, $2`,
 * SQLite marks them `?`, and there are 179 queries across 43 files. Rewriting
 * every one of them by hand is 179 chances to renumber something wrongly in a
 * WHERE clause — a mistake that does not fail loudly, it just returns the
 * wrong rows. Translating here costs one function and leaves every query
 * exactly as it reads today.
 *
 * Times stay TEXT in 'YYYY-MM-DD HH:MM:SS' UTC, as they were. Moving to
 * `timestamptz` is the right end state, but doing it in the same change as the
 * engine swap would leave no way to tell which of the two broke a date.
 */

const CONNECTION =
  process.env.DATABASE_URL?.trim() ||
  "postgres://localhost:5432/assambleya";

/**
 * `bigint` arrives as a JavaScript number, not a string.
 *
 * `COUNT(*)` is bigint in Postgres, and node-postgres hands bigints back as
 * strings because one can exceed `Number.MAX_SAFE_INTEGER`. None here can:
 * every one of them counts rows in a single organisation's tables. What the
 * default does instead is break silently — every counter in this codebase is
 * typed `number`, TypeScript cannot see the difference, and `'0'` is truthy,
 * so a guard like `totals.created ? … : 0` divides by a string zero and
 * returns Infinity. Registered once, here, rather than wrapped in `Number()`
 * at 179 call sites.
 */
types.setTypeParser(20, Number); // int8: COUNT(*), SUM(integer)
// SUM over a bigint widens again, to numeric, and arrives as a string by
// the same rule. The frontend registers both; so does this.
types.setTypeParser(1700, Number); // numeric

type Global = typeof globalThis & { __assambleyaPool?: Pool };

export type Param = string | number | null | undefined;

/**
 * `?` → `$1, $2, …`, leaving anything inside a string literal alone.
 *
 * The scan is character by character rather than a regular expression because
 * a query may legitimately contain a question mark inside quotes — a LIKE
 * pattern, a message body — and a regex replacing every `?` would corrupt it
 * into a parameter that does not exist.
 */
export function toPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  let quote: string | null = null;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];

    if (quote) {
      out += ch;
      // '' inside a single-quoted literal is an escaped quote, not the end.
      if (ch === quote) {
        if (sql[i + 1] === quote) {
          out += sql[++i];
        } else {
          quote = null;
        }
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }

    out += ch === "?" ? `$${++n}` : ch;
  }

  return out;
}

export function pool(): Pool {
  const g = globalThis as Global;
  if (!g.__assambleyaPool) {
    g.__assambleyaPool = new Pool({
      connectionString: CONNECTION,
      // Modest: this runs beside the bot and a Next server on one small box,
      // and Postgres charges memory per connection whether it is busy or not.
      max: Number(process.env.PGPOOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      // A query that has not answered in half a minute is not going to.
      statement_timeout: 30_000,
    });
    // Without this the process dies on a dropped idle connection — a network
    // hiccup between the app and the database becomes a crash.
    g.__assambleyaPool.on("error", (error) => {
      console.error("[pg] idle client error:", error.message);
    });
  }
  return g.__assambleyaPool;
}

export async function all<T>(sql: string, ...params: Param[]): Promise<T[]> {
  const result = await pool().query(toPlaceholders(sql), params as unknown[]);
  return result.rows as T[];
}

export async function get<T>(
  sql: string,
  ...params: Param[]
): Promise<T | undefined> {
  const rows = await all<T>(sql, ...params);
  return rows[0];
}

export async function run(sql: string, ...params: Param[]): Promise<void> {
  await pool().query(toPlaceholders(sql), params as unknown[]);
}

/**
 * INSERT that hands back the new id.
 *
 * SQLite let the caller follow an insert with `SELECT MAX(id)`, which is only
 * correct while one writer exists — the very assumption this move breaks.
 * `RETURNING` is both correct under concurrency and one round trip shorter.
 */
export async function insert(sql: string, ...params: Param[]): Promise<number> {
  const text = /returning/i.test(sql) ? sql : `${sql} RETURNING id`;
  const result = await pool().query(toPlaceholders(text), params as unknown[]);
  return Number(result.rows[0]?.id);
}

/** Queries inside one transaction — the same interface as the module-level
 *  `all` / `get` / `run` / `insert`, so a body can be moved in or out of a
 *  transaction without rewriting its statements. */
export interface Tx {
  all<T>(sql: string, ...params: Param[]): Promise<T[]>;
  get<T>(sql: string, ...params: Param[]): Promise<T | undefined>;
  run(sql: string, ...params: Param[]): Promise<void>;
  insert(sql: string, ...params: Param[]): Promise<number>;
}

/**
 * One transaction on one connection.
 *
 * The module-level helpers take their **own** connection from the pool on
 * every call, so a `BEGIN` issued through `run()` would not cover the next
 * statement — it would open a transaction on a client that is handed straight
 * back. Anything that must happen entirely or not at all goes here: creating a
 * task together with its chain of stages, handing a stage on to the next
 * person. A crash halfway through those would leave `tasks` pointing at one
 * person and `task_stages` insisting on another — an assignment nobody holds,
 * and a defect that is rare and impossible to reproduce.
 */
export async function tx<T>(fn: (q: Tx) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const q: Tx = {
      async all<R>(sql: string, ...params: Param[]) {
        const result = await client.query(toPlaceholders(sql), params as unknown[]);
        return result.rows as R[];
      },
      async get<R>(sql: string, ...params: Param[]) {
        return (await q.all<R>(sql, ...params))[0];
      },
      async run(sql: string, ...params: Param[]) {
        await client.query(toPlaceholders(sql), params as unknown[]);
      },
      async insert(sql: string, ...params: Param[]) {
        const text = /returning/i.test(sql) ? sql : `${sql} RETURNING id`;
        const result = await client.query(toPlaceholders(text), params as unknown[]);
        return Number(result.rows[0]?.id);
      },
    };
    const out = await fn(q);
    await client.query("COMMIT");
    return out;
  } catch (error) {
    // A failed ROLLBACK must not mask the error that caused it.
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** 'YYYY-MM-DD HH:MM:SS' in UTC — the format every stored instant uses. */
export function now(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Applies the schema at boot, exactly once per process.
 *
 * Every statement is `IF NOT EXISTS`, so a second run is a no-op rather than
 * an error — which is what lets the web app and the bot both start without
 * either having to know whether the other went first.
 */
let ready: Promise<void> | null = null;

export function migrate(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      const file = path.join(process.cwd(), "db", "schema.postgres.sql");
      if (!fs.existsSync(file)) return;
      await pool().query(fs.readFileSync(file, "utf8"));
    })();
  }
  return ready;
}
