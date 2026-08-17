import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/**
 * Выгружает всю базу в один SQL-файл для PostgreSQL.
 *
 * Родня `sqlite-to-postgres.mjs`, но тот ходит в целевую базу сам, а этот
 * пишет файл — он нужен там, где до базы сервера не дотянуться напрямую.
 *
 * Свойства те же и по тем же причинам:
 *
 *   - Идентификаторы сохраняются: половина смысла этой базы в ссылках между
 *     таблицами. Перенумеровать строки значит порвать их все.
 *   - Порядок таблиц — от родителей к детям, иначе внешний ключ отвергнет
 *     строку, чей родитель ещё не вставлен.
 *   - Всё в одной транзакции: наполовину перенесённая база хуже
 *     неперенесённой, потому что выглядит рабочей.
 *   - Повторный запуск ничего не портит.
 *
 * Запуск:  node scripts/export-all-sql.mjs > assembly-data.sql
 */

const SQLITE =
  process.env.SQLITE_PATH || path.join(process.cwd(), "data", "assambleya.db");

if (!fs.existsSync(SQLITE)) {
  console.error(`Не найдена база: ${SQLITE}`);
  process.exit(1);
}

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
];

// Привязка к Telegram не переносится: она делается с того устройства, с
// которого человек входит, и старая указывала бы не туда.
const SKIP_COLUMNS = { users: ["telegram_id"] };

const db = new DatabaseSync(SQLITE, { readOnly: true });

function exists(table) {
  return Boolean(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(table),
  );
}

function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "bigint") return String(value);
  if (value instanceof Uint8Array) {
    // Двоичное поле в текстовом дампе: шестнадцатеричный литерал Postgres.
    return `'\\x${Buffer.from(value).toString("hex")}'::bytea`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

const out = [];
out.push("-- Полные данные ASSEMBLY OS для PostgreSQL.");
out.push("-- Схема должна быть применена заранее: db/schema.postgres.sql");
out.push("-- Содержит хеши паролей и переписку — удалить файл после выполнения.");
out.push("");
out.push("BEGIN;");

const counts = [];

for (const table of ORDER) {
  if (!exists(table)) {
    counts.push([table, "нет"]);
    continue;
  }
  const skip = SKIP_COLUMNS[table] ?? [];
  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name)
    .filter((c) => !skip.includes(c));

  const rows = db.prepare(`SELECT ${columns.join(", ")} FROM ${table}`).all();
  counts.push([table, String(rows.length)]);
  if (rows.length === 0) continue;

  const hasId = columns.includes("id");
  out.push("");
  out.push(`-- ${table}: ${rows.length}`);
  for (const row of rows) {
    const values = columns.map((c) => literal(row[c])).join(", ");
    out.push(
      `INSERT INTO ${table} (${columns.join(", ")}) ` +
        `${hasId ? "OVERRIDING SYSTEM VALUE " : ""}VALUES (${values}) ` +
        `ON CONFLICT DO NOTHING;`,
    );
  }
}

out.push("");
out.push("-- Счётчики идентификаторов за максимум, иначе первая же вставка");
out.push("-- после переноса столкнётся с занятым номером.");
for (const [table, n] of counts) {
  if (n === "нет") continue;
  const columns = db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
  if (!columns.includes("id")) continue;
  out.push(
    `SELECT setval(pg_get_serial_sequence('${table}','id'), ` +
      `GREATEST((SELECT COALESCE(MAX(id),0) FROM ${table}), 1));`,
  );
}

out.push("");
out.push("COMMIT;");
out.push("");
out.push("-- Сверка: сколько строк доехало.");
out.push(
  "SELECT 'users' AS t, count(*) FROM users\n" +
    counts
      .filter(([t, n]) => n !== "нет" && t !== "users")
      .map(([t]) => `UNION ALL SELECT '${t}', count(*) FROM ${t}`)
      .join("\n") +
    "\nORDER BY 1;",
);

process.stdout.write(out.join("\n") + "\n");

console.error("Выгружено:");
for (const [table, n] of counts) console.error(`  ${table.padEnd(22)} ${n}`);
db.close();
