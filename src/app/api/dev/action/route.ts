import { NextResponse } from "next/server";
import { spawnSync } from "node:child_process";
import { get, now, run } from "@/lib/pg";
import { hashPassword } from "@/lib/auth";
import { hasDevAccess } from "@/lib/dev-auth";
import { clearPresence } from "@/lib/presence";
import { ROLES, TASK_STATUSES, type Role, type TaskStatus } from "@/lib/types";

const DEMO_PASSWORD = "12345678";

function ok(message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ ok: true, message, ...extra });
}
function fail(message: string, status = 400) {
  return NextResponse.json({ ok: false, message }, { status });
}

export async function POST(request: Request) {
  if (!(await hasDevAccess())) return fail("Forbidden", 403);

  const body = (await request.json()) as {
    type?: string;
    id?: number;
    role?: string;
    status?: string;
    toUserId?: number;
  };
  const type = body.type ?? "";
  const id = Number(body.id);

  try {
    switch (type) {
      case "user.toggleActive": {
        const u = await get<{ is_active: number; full_name: string }>(
          "SELECT is_active, full_name FROM users WHERE id = ?",
          id,
        );
        if (!u) return fail("Пользователь не найден", 404);
        const next = u.is_active ? 0 : 1;
        await run("UPDATE users SET is_active = ? WHERE id = ?", next, id);
        return ok(`${u.full_name}: ${next ? "активен" : "деактивирован"}`);
      }
      case "user.setRole": {
        if (!ROLES.includes(body.role as Role)) return fail("Неизвестная роль");
        await run("UPDATE users SET role = ? WHERE id = ?", body.role!, id);
        return ok(`Роль изменена на ${body.role}`);
      }
      case "user.resetPassword": {
        const u = await get<{ login: string }>("SELECT login FROM users WHERE id = ?", id);
        if (!u) return fail("Пользователь не найден", 404);
        await run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(DEMO_PASSWORD), id);
        return ok(`Пароль @${u.login} сброшен на ${DEMO_PASSWORD}`);
      }
      case "user.delete": {
        try {
          await run("DELETE FROM users WHERE id = ?", id);
          return ok("Пользователь удалён");
        } catch {
          return fail(
            "Нельзя удалить: у пользователя есть задачи/сообщения. Деактивируйте вместо удаления.",
            409,
          );
        }
      }
      case "task.setStatus": {
        if (!TASK_STATUSES.includes(body.status as TaskStatus))
          return fail("Неизвестный статус");
        await run("UPDATE tasks SET status = ? WHERE id = ?", body.status!, id);
        await run(
          "INSERT INTO task_events (task_id, user_id, action, comment, created_at) SELECT ?, from_user_id, ?, 'dev: смена статуса', ? FROM tasks WHERE id = ?",
          id,
          body.status!,
          now(),
          id,
        );
        return ok(`Статус задачи → ${body.status}`);
      }
      case "task.reassign": {
        const to = Number(body.toUserId);
        const u = await get<{ full_name: string; department: string | null; uyushma_id: number | null }>(
          "SELECT full_name, department, uyushma_id FROM users WHERE id = ?",
          to,
        );
        if (!u) return fail("Исполнитель не найден", 404);
        await run(
          "UPDATE tasks SET to_user_id = ?, to_department = ?, uyushma_id = ? WHERE id = ?",
          to,
          u.department,
          u.uyushma_id ?? null,
          id,
        );
        return ok(`Переназначено на ${u.full_name}`);
      }
      case "task.delete": {
        await run("DELETE FROM task_events WHERE task_id = ?", id);
        await run("DELETE FROM tasks WHERE id = ?", id);
        return ok("Задача удалена");
      }
      // WAL checkpoint и VACUUM жили здесь, пока база была файлом. У сервера
      // обслуживанием занимается он сам (autovacuum), и кнопка в панели не
      // ускорила бы его, а только дала бы повод её нажать.
      case "maint.clearPresence": {
        const n = clearPresence();
        return ok(`Присутствие сброшено (${n} пользователей помечены офлайн)`);
      }
      case "maint.reseed": {
        const res = spawnSync("node", ["scripts/seed.mjs"], {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 60_000,
        });
        if (res.status !== 0) {
          return fail(`Сид завершился с ошибкой:\n${res.stderr || res.stdout}`, 500);
        }
        return ok("База пересоздана из демо-данных", { output: res.stdout.trim() });
      }
      default:
        return fail("Неизвестное действие");
    }
  } catch (error) {
    return fail(`Ошибка: ${(error as Error).message}`, 500);
  }
}
