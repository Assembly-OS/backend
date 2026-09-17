import pg from "pg";

/**
 * Привязывает осиротевшие поручения к отделам.
 *
 * Запуск:
 *   DATABASE_URL=postgres://user:pass@host/db node scripts/backfill-departments.mjs
 *   DATABASE_URL=... node scripts/backfill-departments.mjs --apply
 *
 * Без `--apply` ничего не пишет — только показывает, что будет сделано.
 *
 * Зачем это отдельный скрипт, а не миграция:
 *
 *   Поручение берёт отдел у своего исполнителя — так было всегда, и код
 *   создания поручения тут ни при чём. Осиротевшие строки появились оттого,
 *   что у самого исполнителя отдел пуст. Аудит нашёл 26 таких из 67 (39%), и
 *   диаграмма на странице статистики показывала 41 вместо 67: председатель
 *   читал 61% работы как если бы это была вся работа.
 *
 *   Поэтому чинится в два приёма, и только первый можно доверить машине.
 *   Отдел поручения восстанавливается из исполнителя — это не догадка, это то
 *   же правило, по которому он проставился бы при создании. А вот отдел
 *   самого сотрудника выбрать за человека нельзя: приписать кого-то не в тот
 *   отдел хуже, чем оставить пустым, потому что пустое видно, а неверное — нет.
 *   Таких скрипт называет поимённо и оставляет решение людям.
 *
 *   Всё в одной транзакции: наполовину привязанные поручения дают ту же
 *   расходящуюся цифру, ради которой всё и затевалось.
 */

const APPLY = process.argv.includes("--apply");
const CONNECTION =
  process.env.DATABASE_URL?.trim() || "postgres://localhost:5432/assambleya";

const pool = new pg.Pool({ connectionString: CONNECTION });

/** Ровняет колонку, чтобы отчёт читался без таблицы. */
function pad(value, width) {
  return String(value).padEnd(width);
}

async function main() {
  const client = await pool.connect();
  try {
    /* --- 1. Сотрудники без отдела — решение за человеком ---------------- */

    const { rows: staff } = await client.query(
      `SELECT id, login, full_name, role
         FROM users
        WHERE department IS NULL AND is_active = 1 AND role <> 'RAIS'
        ORDER BY role, full_name`,
    );

    console.log(`\nСотрудники без отдела: ${staff.length}`);
    if (staff.length) {
      console.log("  Отдел за них выбрать нельзя — назначьте вручную:\n");
      for (const u of staff) {
        console.log(
          `    ${pad(u.login, 24)} ${pad(u.role, 16)} ${u.full_name}`,
        );
      }
      console.log(
        "\n  Пока отдел пуст, каждое новое поручение этому человеку\n" +
          "  снова окажется вне диаграммы.",
      );
    }

    /* --- 2. Поручения без отдела --------------------------------------- */

    const { rows: [counts] } = await client.query(
      `SELECT
         COUNT(*)                                        AS orphans,
         COUNT(*) FILTER (WHERE u.department IS NOT NULL) AS fixable,
         COUNT(*) FILTER (WHERE u.department IS NULL)     AS blocked
       FROM tasks t
       JOIN users u ON u.id = t.to_user_id
      WHERE t.to_department IS NULL`,
    );

    const orphans = Number(counts.orphans);
    const fixable = Number(counts.fixable);
    const blocked = Number(counts.blocked);

    console.log(`\nПоручения без отдела: ${orphans}`);
    console.log(`  восстановимо из исполнителя: ${fixable}`);
    console.log(`  ждёт отдела исполнителя:     ${blocked}`);

    /* --- 3. Запись ------------------------------------------------------ */

    if (!APPLY) {
      console.log(
        `\nПробный прогон. Чтобы применить — повторите с --apply.\n`,
      );
      return;
    }

    if (fixable === 0) {
      console.log("\nНечего применять.\n");
      return;
    }

    await client.query("BEGIN");
    // uyushma_id заполняется тем же движением и по той же причине: он тоже
    // берётся у исполнителя при создании и тоже пуст у осиротевших строк.
    const { rowCount } = await client.query(
      `UPDATE tasks t
          SET to_department = u.department,
              uyushma_id    = COALESCE(t.uyushma_id, u.uyushma_id)
         FROM users u
        WHERE u.id = t.to_user_id
          AND t.to_department IS NULL
          AND u.department IS NOT NULL`,
    );
    await client.query("COMMIT");

    console.log(`\nПривязано поручений: ${rowCount}`);

    const { rows: [left] } = await client.query(
      "SELECT COUNT(*) AS n FROM tasks WHERE to_department IS NULL",
    );
    const remaining = Number(left.n);
    console.log(`Осталось без отдела: ${remaining}`);
    if (remaining) {
      console.log(
        "Это те, чей исполнитель сам без отдела. Назначьте отделы из\n" +
          "списка выше и запустите скрипт ещё раз.\n",
      );
    } else {
      console.log(
        "Сирот нет: итог на диаграмме теперь равен итогу на главной.\n",
      );
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
