import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";

/**
 * Дописывает в схему PostgreSQL колонки, которых там не хватает.
 *
 * Схема портировалась из `db/schema.sql`, но часть колонок появлялась не там,
 * а миграциями в коде — `ALTER TABLE ... ADD COLUMN` при запуске. Искать их по
 * истории правок ненадёжно: что-то добавлялось скриптами, что-то руками.
 * Источник истины — сама рабочая база, поэтому сравниваем с ней.
 *
 * Запуск:
 *   DATABASE_URL=postgres://localhost:5432/имя node scripts/schema-diff.mjs
 */

const SQLITE =
  process.env.SQLITE_PATH || path.join(process.cwd(), "data", "assambleya.db");
const TARGET = process.env.DATABASE_URL;
const SCHEMA = path.join(process.cwd(), "db", "schema.postgres.sql");

if (!TARGET) {
  console.error("Укажите DATABASE_URL — с какой базой сверять.");
  process.exit(1);
}

const TYPES = {
  INTEGER: "INTEGER",
  INT: "INTEGER",
  TEXT: "TEXT",
  REAL: "DOUBLE PRECISION",
  BLOB: "BYTEA",
  NUMERIC: "NUMERIC",
  BOOLEAN: "INTEGER",
};

const source = new DatabaseSync(SQLITE, { readOnly: true });
const client = new pg.Client({ connectionString: TARGET });
await client.connect();

const tables = source
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  )
  .all()
  .map((r) => r.name);

const missing = [];

for (const table of tables) {
  const ours = (
    await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      [table],
    )
  ).rows.map((r) => r.column_name);

  // Таблицы, которой нет в целевой схеме, здесь не создаём: её отсутствие
  // это решение (meeting_live не переносится), а не упущение.
  if (ours.length === 0) continue;

  for (const col of source.prepare(`PRAGMA table_info(${table})`).all()) {
    if (ours.includes(col.name)) continue;
    const base = (col.type || "TEXT").toUpperCase().split("(")[0];
    const type = TYPES[base] ?? "TEXT";
    // DEFAULT переносим как есть: в этой схеме это литералы, а не вызовы
    // функций SQLite.
    const def = col.dflt_value ? ` DEFAULT ${col.dflt_value}` : "";
    missing.push({
      table,
      column: col.name,
      sql: `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col.name} ${type}${def};`,
    });
  }
}

await client.end();
source.close();

if (missing.length === 0) {
  console.log("Расхождений нет: схема покрывает все колонки рабочей базы.");
  process.exit(0);
}

const block =
  "\n-- Колонки, добавленные миграциями поверх исходной схемы.\n" +
  "-- Собраны сравнением с рабочей базой, а не по истории правок:\n" +
  "-- база — источник истины о том, что в ней на самом деле есть.\n" +
  missing.map((m) => m.sql).join("\n") +
  "\n";

fs.appendFileSync(SCHEMA, block);

console.log(`Дописано в ${path.basename(SCHEMA)}: ${missing.length}`);
for (const m of missing) console.log(`  ${m.table}.${m.column}`);
