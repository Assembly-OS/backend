import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

/**
 * Переносит данные из SQLite в PostgreSQL.
 *
 * Запуск:
 *   DATABASE_URL=postgres://user:pass@host/db node scripts/sqlite-to-postgres.mjs
 *
 * Переносит только строки: схему в целевой базе надо применить заранее
 * (db/schema.postgres.sql). Так и задумано — схема разворачивается один раз
 * при установке, а перенос может понадобиться повторно.
 *
 * Свойства, ради которых написано именно так:
 *
 *   - Идентификаторы сохраняются. Половина смысла этой базы — в ссылках между
 *     таблицами: кто кому выдал поручение, к какому совещанию относится вывод.
 *     Перенумеровать строки значит порвать их все.
 *
 *   - Порядок таблиц — от родителей к детям, иначе внешний ключ отвергнет
 *     строку, чей родитель ещё не перенесён.
 *
 *   - Всё в одной транзакции. Наполовину перенесённая база хуже
 *     неперенесённой: она выглядит рабочей.
 */

const SQLITE =
  process.env.SQLITE_PATH ||
  path.join(process.cwd(), "data", "assambleya.db");

const TARGET = process.env.DATABASE_URL;
if (!TARGET) {
  console.error("Укажите DATABASE_URL — куда переносить.");
  process.exit(1);
}
if (!fs.existsSync(SQLITE)) {
  console.error(`Не найдена база SQLite: ${SQLITE}`);
  process.exit(1);
}

/**
 * Родители раньше детей. Порядок выведен из внешних ключей схемы; таблица,
 * которой здесь нет, не переносится вовсе — это защита от случайного переноса
 * чего-то временного вроде meeting_live.
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
];

const source = new DatabaseSync(SQLITE, { readOnly: true });
const client = new pg.Client({ connectionString: TARGET });

function columnsOf(table) {
  return source
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}

function exists(table) {
  return Boolean(
    source
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

/**
 * Пары строк, которые в SQLite были разными, а в Postgres станут одной.
 *
 * Регистронезависимость логина и названия компании задана здесь уникальными
 * индексами по lower(...), которых в SQLite не было: `users.login` был просто
 * UNIQUE, а COLLATE NOCASE на `partners.name` сворачивал только ASCII — «Узум»
 * и «УЗУМ» жили там как две компании. При переносе одна из пары молча уходит
 * в ON CONFLICT DO NOTHING, а падает перенос через несколько таблиц, на
 * внешнем ключе, который на настоящую причину не указывает.
 *
 * toLowerCase() в JS сворачивает Unicode так же, как lower() в Postgres,
 * поэтому ищем столкновения тем же правилом, каким их найдёт целевая база.
 */
function caseCollisions(table, column) {
  if (!exists(table)) return [];
  const seen = new Map();
  const clashes = [];
  for (const row of source.prepare(`SELECT id, ${column} FROM ${table}`).all()) {
    const key = String(row[column] ?? "").toLowerCase();
    const first = seen.get(key);
    if (first) clashes.push([table, column, first, row]);
    else seen.set(key, row);
  }
  return clashes;
}

const collisions = [
  ...caseCollisions("users", "login"),
  ...caseCollisions("partners", "name"),
];
if (collisions.length > 0) {
  console.error(
    "Перенос не начат: эти значения в PostgreSQL уникальны без учёта регистра.\n" +
      "Приведите каждую пару к одному виду или удалите лишнюю строку, затем\n" +
      "запустите снова — иначе одна из них потеряется вместе со всем, что на\n" +
      "неё ссылается.",
  );
  for (const [table, column, a, b] of collisions)
    console.error(
      `  ${table}.${column}: id ${a.id} «${a[column]}» и id ${b.id} «${b[column]}»`,
    );
  source.close();
  process.exit(1);
}

await client.connect();

try {
  await client.query("BEGIN");

  const report = [];

  for (const table of ORDER) {
    if (!exists(table)) {
      report.push([table, "нет в источнике"]);
      continue;
    }

    // Колонки берём по пересечению: миграции добавляли столбцы в обе стороны,
    // и переносить надо то, что есть и там, и там.
    const theirs = columnsOf(table);
    const ours = (
      await client.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      )
    ).rows.map((r) => r.column_name);

    const cols = theirs.filter((c) => ours.includes(c));
    if (cols.length === 0) {
      report.push([table, "нет общих колонок"]);
      continue;
    }

    // Колонка, которая есть в источнике и которой нет в целевой схеме, тихо
    // выпадает из пересечения вместе со всем, что в ней записано. Молчать об
    // этом нельзя: перенос выглядел бы успешным.
    const dropped = theirs.filter((c) => !ours.includes(c));
    if (dropped.length > 0)
      console.warn(`  ! ${table}: нет в целевой схеме — ${dropped.join(", ")}`);

    const rows = source.prepare(`SELECT ${cols.join(", ")} FROM ${table}`).all();
    if (rows.length === 0) {
      report.push([table, "0"]);
      continue;
    }

    const list = cols.join(", ");
    const marks = cols.map((_, i) => `$${i + 1}`).join(", ");
    const insert = `INSERT INTO ${table} (${list}) VALUES (${marks})
                    ON CONFLICT DO NOTHING`;

    // Колонки-идентификаторы объявлены GENERATED ALWAYS: без OVERRIDING
    // Postgres откажется принимать наши значения и подставит свои, порвав
    // все ссылки между таблицами.
    const withIds = cols.includes("id")
      ? insert.replace("VALUES", "OVERRIDING SYSTEM VALUE VALUES")
      : insert;

    // Считаем вставленное, а не прочитанное: ON CONFLICT DO NOTHING проглотит
    // строку, столкнувшуюся с уникальным индексом (в Postgres их больше, чем
    // было в SQLite), и без этого счётчика потеря осталась бы незаметной.
    let written = 0;
    for (const row of rows) {
      const res = await client.query(
        withIds,
        cols.map((c) => (row[c] === undefined ? null : row[c])),
      );
      written += res.rowCount;
    }
    report.push([
      table,
      written === rows.length
        ? String(rows.length)
        : `${written} из ${rows.length} — ПРОПУЩЕНО ${rows.length - written}`,
    ]);
  }

  // Счётчики идентификаторов сдвигаем за максимум, иначе первая же вставка
  // после переноса столкнётся с занятым id.
  for (const [table] of report) {
    const has = (
      await client.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 AND column_name='id'`,
        [table],
      )
    ).rowCount;
    if (!has) continue;
    // Третий аргумент false означает «это ещё не выданное значение»: тогда
    // следующий nextval вернёт ровно MAX(id) + 1, а на пустой таблице — 1,
    // без пропуска первого идентификатора.
    await client.query(
      `SELECT setval(pg_get_serial_sequence('${table}', 'id'),
                     (SELECT COALESCE(MAX(id), 0) + 1 FROM ${table}), false)`,
    );
  }

  await client.query("COMMIT");

  console.log("Перенесено:");
  for (const [table, n] of report) console.log(`  ${table.padEnd(22)} ${n}`);
} catch (error) {
  await client.query("ROLLBACK");
  console.error("Перенос отменён целиком:", error.message);
  process.exitCode = 1;
} finally {
  await client.end();
  source.close();
}
