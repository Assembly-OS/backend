import { NextResponse } from "next/server";
import { db, get, now, run } from "@/lib/db";
import { hasDevAccess } from "@/lib/dev-auth";
import { clearPresence } from "@/lib/presence";
import { ROLES, TASK_STATUSES, type Role, type TaskStatus } from "@/lib/types";

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
        const u = get<{ is_active: number; full_name: string }>(
          "SELECT is_active, full_name FROM users WHERE id = ?",
          id,
        );
        if (!u) return fail("Пользователь не найден", 404);
        const next = u.is_active ? 0 : 1;
        run("UPDATE users SET is_active = ? WHERE id = ?", next, id);
        return ok(`${u.full_name}: ${next ? "активен" : "деактивирован"}`);
      }
      case "user.setRole": {
        if (!ROLES.includes(body.role as Role)) return fail("Неизвестная роль");
        run("UPDATE users SET role = ? WHERE id = ?", body.role!, id);
        return ok(`Роль изменена на ${body.role}`);
      }
      case "user.delete": {
        try {
          run("DELETE FROM users WHERE id = ?", id);
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
        run("UPDATE tasks SET status = ? WHERE id = ?", body.status!, id);
        run(
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
        const u = get<{ full_name: string; department: string | null; uyushma_id: number | null }>(
          "SELECT full_name, department, uyushma_id FROM users WHERE id = ?",
          to,
        );
        if (!u) return fail("Исполнитель не найден", 404);
        run(
          "UPDATE tasks SET to_user_id = ?, to_department = ?, uyushma_id = ? WHERE id = ?",
          to,
          u.department,
          u.uyushma_id ?? null,
          id,
        );
        return ok(`Переназначено на ${u.full_name}`);
      }
      case "task.delete": {
        run("DELETE FROM task_events WHERE task_id = ?", id);
        run("DELETE FROM tasks WHERE id = ?", id);
        return ok("Задача удалена");
      }
      case "maint.walCheckpoint": {
        db().exec("PRAGMA wal_checkpoint(TRUNCATE);");
        return ok("WAL свёрнут (checkpoint TRUNCATE)");
      }
      case "maint.vacuum": {
        db().exec("VACUUM;");
        return ok("VACUUM выполнен — база сжата");
      }
      case "maint.clearPresence": {
        const n = clearPresence();
        return ok(`Присутствие сброшено (${n} пользователей помечены офлайн)`);
      }
      default:
        return fail("Неизвестное действие");
    }
  } catch (error) {
    return fail(`Ошибка: ${(error as Error).message}`, 500);
  }
}
