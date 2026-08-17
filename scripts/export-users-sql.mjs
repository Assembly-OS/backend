import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/**
 * Выгружает сотрудников в SQL для PostgreSQL.
 *
 * Нужен там, где до базы сервера не дотянуться напрямую: файл переносится
 * любым способом и выполняется на месте.
 *
 * Переносятся и хеши паролей — иначе людям пришлось бы выдавать новые. Хеш
 * это не пароль: из него исходный пароль не восстановить, но проверку он
 * проходит, поэтому все нынешние пароли продолжат работать.
 *
 * Идентификаторы сохраняются: на них ссылаются поручения, совещания и
 * переписка. Перенумеровать сотрудников значит порвать всё, что о них знает
 * система.
 *
 * Запуск:  node scripts/export-users-sql.mjs > users.sql
 */

const SQLITE =
  process.env.SQLITE_PATH || path.join(process.cwd(), "data", "assambleya.db");

if (!fs.existsSync(SQLITE)) {
  console.error(`Не найдена база: ${SQLITE}`);
  process.exit(1);
}

const db = new DatabaseSync(SQLITE, { readOnly: true });

const columns = db
  .prepare("PRAGMA table_info(users)")
  .all()
  .map((c) => c.name)
  // telegram_id намеренно не переносим: привязка делается с того устройства,
  // с которого человек входит, и старая может указывать на чужой аккаунт.
  .filter((c) => c !== "telegram_id");

const rows = db.prepare(`SELECT ${columns.join(", ")} FROM users ORDER BY id`).all();

function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

const out = [];
out.push("-- Сотрудники ASSEMBLY OS для PostgreSQL.");
out.push("-- Содержит хеши паролей: файл удалить с сервера после выполнения.");
out.push(`-- Выгружено из ${path.basename(SQLITE)}, строк: ${rows.length}`);
out.push("");
out.push("BEGIN;");
out.push("");

for (const row of rows) {
  const values = columns.map((c) => literal(row[c])).join(", ");
  out.push(
    `INSERT INTO users (${columns.join(", ")})\n` +
      `OVERRIDING SYSTEM VALUE VALUES (${values})\n` +
      // Повторный запуск не создаёт двойников и не затирает того, кто мог
      // сменить пароль уже на сервере.
      `ON CONFLICT (id) DO NOTHING;`,
  );
}

out.push("");
out.push("-- Счётчик за максимум, иначе следующий добавленный человек");
out.push("-- столкнётся с занятым номером.");
out.push(
  "SELECT setval(pg_get_serial_sequence('users', 'id'),\n" +
    "              GREATEST((SELECT COALESCE(MAX(id), 0) FROM users), 1));",
);
out.push("");
out.push("COMMIT;");
out.push("");
out.push("SELECT id, login, full_name, role FROM users ORDER BY id;");

process.stdout.write(out.join("\n") + "\n");
db.close();
