import pg from "pg";

/**
 * Ищет повторы в списках поручений.
 *
 * Запуск:
 *   DATABASE_URL=postgres://user:pass@host/db node scripts/check-duplicates.mjs
 *
 * Только читает. Безопасно запускать на рабочей базе.
 *
 * Зачем:
 *
 *   Аудит перед ТЗ зафиксировал: при нажатии «Yana ko'rsatish» восемь
 *   поручений выходят дважды. На текущем main ни один из запросов, питающих
 *   этот список, повтор вернуть не может — все они читают `tasks` по одной
 *   строке на поручение, а соединения идут по уникальным ключам: `users.id`,
 *   `loyihalar.id` и `task_stages(task_id, position)`, где уникальность задана
 *   ограничением в схеме. Похоже, дефект уже устранён — ТЗ само допускает, что
 *   часть дефектов исправлена, пока писался документ.
 *
 *   Но «похоже» проверяется не рассуждением, а запуском на тех данных, где
 *   дефект видели. Отсюда скрипт: он повторяет соединения `TASK_SELECT` и
 *   считает, сколько строк приходится на одно поручение. Больше одной — это
 *   и есть повтор, и тогда он назовёт поручение и покажет, какое соединение
 *   размножило строку.
 *
 *   Запросы здесь повторены, а не импортированы из `src/lib/queries.ts`:
 *   узлы Node не разрешают расширения во внутренних импортах этого модуля.
 *   Поэтому скрипт проверяет не текст запросов, а форму данных под ними —
 *   она и решает, может ли список раздвоиться, и переживёт правку любого
 *   отдельного запроса.
 */

const CONNECTION =
  process.env.DATABASE_URL?.trim() || "postgres://localhost:5432/assambleya";
const pool = new pg.Pool({ connectionString: CONNECTION });

/** Соединения, которые делает TASK_SELECT, и во что каждое упирается. */
const JOINS = [
  {
    name: "users (from_user_id)",
    sql: `SELECT t.id, COUNT(*) AS n FROM tasks t
            JOIN users uf ON uf.id = t.from_user_id
           GROUP BY t.id HAVING COUNT(*) > 1`,
  },
  {
    name: "users (to_user_id)",
    sql: `SELECT t.id, COUNT(*) AS n FROM tasks t
            JOIN users ut ON ut.id = t.to_user_id
           GROUP BY t.id HAVING COUNT(*) > 1`,
  },
  {
    name: "loyihalar",
    sql: `SELECT t.id, COUNT(*) AS n FROM tasks t
            LEFT JOIN loyihalar l ON l.id = t.loyiha_id
           GROUP BY t.id HAVING COUNT(*) > 1`,
  },
  {
    name: "task_stages (текущий этап)",
    sql: `SELECT t.id, COUNT(*) AS n FROM tasks t
            LEFT JOIN task_stages cs ON cs.task_id = t.id AND cs.position = t.current_stage
           GROUP BY t.id HAVING COUNT(*) > 1`,
  },
  {
    name: "task_stages (предыдущий этап)",
    sql: `SELECT t.id, COUNT(*) AS n FROM tasks t
            LEFT JOIN task_stages ps ON ps.task_id = t.id AND ps.position = t.current_stage - 1
           GROUP BY t.id HAVING COUNT(*) > 1`,
  },
  {
    name: "TASK_SELECT целиком",
    sql: `SELECT t.id, COUNT(*) AS n FROM tasks t
            JOIN users uf ON uf.id = t.from_user_id
            JOIN users ut ON ut.id = t.to_user_id
            LEFT JOIN loyihalar l ON l.id = t.loyiha_id
            LEFT JOIN task_stages cs ON cs.task_id = t.id AND cs.position = t.current_stage
            LEFT JOIN task_stages ps ON ps.task_id = t.id AND ps.position = t.current_stage - 1
           GROUP BY t.id HAVING COUNT(*) > 1`,
  },
];

async function main() {
  const client = await pool.connect();
  try {
    const { rows: [{ n: total }] } = await client.query(
      "SELECT COUNT(*) AS n FROM tasks",
    );
    console.log(`\nПоручений в базе: ${total}\n`);

    let bad = 0;
    for (const join of JOINS) {
      const { rows } = await client.query(join.sql);
      if (rows.length === 0) {
        console.log(`  ok   ${join.name}`);
        continue;
      }
      bad += 1;
      console.log(`  ПОВТОР  ${join.name} — поручений затронуто: ${rows.length}`);
      for (const r of rows.slice(0, 8)) {
        console.log(`            поручение ${r.id} × ${r.n}`);
      }
      if (rows.length > 8) console.log(`            … и ещё ${rows.length - 8}`);
    }

    // Ограничение, на котором держатся два последних соединения. Если его
    // когда-нибудь снимут, повторы вернутся — и это будет видно здесь, а не
    // через полгода в списке у председателя.
    const { rows: dupStages } = await client.query(
      `SELECT task_id, position, COUNT(*) AS n
         FROM task_stages GROUP BY task_id, position HAVING COUNT(*) > 1`,
    );
    if (dupStages.length) {
      bad += 1;
      console.log(
        `\n  ПОВТОР  task_stages: пара (task_id, position) не уникальна — ${dupStages.length} случаев`,
      );
    } else {
      console.log("  ok   task_stages(task_id, position) уникальна");
    }

    console.log(
      bad === 0
        ? "\nПовторов нет. Критерий ТЗ «Ro'yxatlarda dublikat yo'q» на этих данных выполняется.\n"
        : `\nНайдено проблемных соединений: ${bad}.\n`,
    );
    process.exitCode = bad === 0 ? 0 : 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
