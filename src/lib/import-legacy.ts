import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pool } from "./pg";

/**
 * One-time import of the SQLite database into PostgreSQL, at boot.
 *
 * `scripts/sqlite-to-postgres.mjs` already does this correctly, and this is a
 * deliberate second copy of it rather than a replacement. The script needs a
 * shell on the machine holding both databases, and there is none: the runtime
 * image contains `.next/standalone`, `.next/static` and `db/schema.postgres.sql` and
 * nothing else — no `scripts/` directory to run, no shell access to the VPS.
 * The one process that can reach both the old file and the new server is the
 * backend itself, so the import happens where it can happen.
 *
 * It runs on every boot and does nothing on all but the first: an import into
 * a database that already holds people would be a way to lose work, not move
 * it. The guard is "are there users", because a platform with no users is a
 * platform nobody has used yet.
 */

/**
 * Parents before children, from the schema's foreign keys.
 *
 * A table absent from this list is not imported at all, which is the point for
 * `meeting_live`: a half-finished recording is a session, not a record, and
 * carrying one across an engine change would resume a meeting that ended.
 */
const ORDER = [
  "users",
  "uyushmalar",
  "loyihalar",
  "partners",
  "tasks",
  "task_events",
  "chat_groups",
  "group_members",
  "group_reads",
  "messages",
  "agent_runs",
  "agent_proposals",
  "meetings",
  "meeting_memory",
  "meeting_conclusions",
  "partner_notes",
  "partner_ideas",
  "contacts",
  "agreements",
  "reminders",
  "notifications",
  "assistant_messages",
] as const;

function legacyPath(): string {
  const dir = process.env.ASSAMBLEYA_DATA_DIR || path.join(process.cwd(), "data");
  return path.join(dir, "assambleya.db");
}

let done: Promise<void> | null = null;

/** Imports once per process; later calls await the first one's outcome. */
export function importLegacy(): Promise<void> {
  if (!done) done = run();
  return done;
}

async function run(): Promise<void> {
  const file = legacyPath();
  if (!fs.existsSync(file)) return;

  const client = await pool().connect();
  try {
    // Anyone in the users table means this database is in service. Importing
    // over it would duplicate rows at best and overwrite edited ones at worst.
    const occupied = await client.query<{ n: string }>(
      "SELECT COUNT(*) AS n FROM users",
    );
    if (Number(occupied.rows[0]?.n ?? 0) > 0) return;

    const source = new DatabaseSync(file, { readOnly: true });
    const moved: [string, number][] = [];

    try {
      // One transaction: a half-imported database is worse than an empty one,
      // because it looks like it worked.
      await client.query("BEGIN");

      for (const table of ORDER) {
        const present = source
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get(table);
        if (!present) continue;

        // Columns by intersection. Migrations added columns to each side
        // independently, so only what both know about can cross.
        const theirs = (
          source.prepare(`PRAGMA table_info(${table})`).all() as {
            name: string;
          }[]
        ).map((column) => column.name);

        const ours = (
          await client.query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = $1`,
            [table],
          )
        ).rows.map((row) => row.column_name);

        const columns = theirs.filter((column) => ours.includes(column));
        if (columns.length === 0) continue;

        const rows = source
          .prepare(`SELECT ${columns.join(", ")} FROM ${table}`)
          .all() as Record<string, unknown>[];
        if (rows.length === 0) continue;

        const marks = columns.map((_, i) => `$${i + 1}`).join(", ");
        // Ids are GENERATED ALWAYS. Without OVERRIDING, Postgres discards the
        // value handed to it and assigns its own — which silently renumbers
        // every row and breaks every reference between the tables. Half the
        // meaning of this database is in those references.
        const overriding = columns.includes("id")
          ? "OVERRIDING SYSTEM VALUE "
          : "";
        const statement =
          `INSERT INTO ${table} (${columns.join(", ")}) ` +
          `${overriding}VALUES (${marks}) ON CONFLICT DO NOTHING`;

        for (const row of rows) {
          await client.query(
            statement,
            columns.map((column) => row[column] ?? null),
          );
        }
        moved.push([table, rows.length]);
      }

      // Identity counters still sit at 1: they were never consulted, because
      // every id was supplied. The next insert would collide with row 1.
      for (const [table] of moved) {
        await client.query(
          `SELECT setval(pg_get_serial_sequence('${table}', 'id'),
                         GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table}), 1))`,
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      // Loud, and then out of the way: the platform starts on an empty
      // database rather than refusing to boot, and the old file is untouched
      // and still importable once the cause is fixed.
      console.error(
        "[import] SQLite import rolled back, nothing was written:",
        error instanceof Error ? error.message : error,
      );
      return;
    } finally {
      source.close();
    }

    const total = moved.reduce((sum, [, n]) => sum + n, 0);
    console.log(
      `[import] moved ${total} rows from ${file}: ` +
        moved.map(([table, n]) => `${table}=${n}`).join(" "),
    );
  } finally {
    client.release();
  }
}
