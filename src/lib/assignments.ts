import { get, now, tx } from "@/lib/pg";
import { publish } from "@/lib/events";
import { notify } from "@/lib/notifications";
import { assignableUsers } from "@/lib/queries";
import type { User } from "@/lib/types";

export interface AssignmentDraft {
  toUserId: number;
  title: string;
  description?: string | null;
  priority?: string;
  deadline?: string | null;
}

/**
 * Raises one plain assignment the way a person's own form would.
 *
 * Moved out of the intake runner when a second caller arrived: a meeting's next
 * step becomes an assignment too (block 1.1 of the rebuild TZ), and two copies
 * of "insert the task, its stage row, its event, then ping" would drift the way
 * the dashboard's counters did. Same code sequence, same stage row, same audit
 * event, same Telegram ping — so nothing downstream can tell where an
 * assignment came from except the event's note, which says so.
 *
 * The assignment graph is checked here, at execution time, and not only by
 * the caller: whoever is named must be somebody the author may assign to
 * right now. A meeting form or an approved AI draft is not a way around that.
 */
export async function createAssignment(
  authorId: number,
  draft: AssignmentDraft,
  note: string,
): Promise<{ id: number; code: string }> {
  const author = await get<User>("SELECT * FROM users WHERE id = ?", authorId);
  const assignee = await get<User>(
    "SELECT * FROM users WHERE id = ? AND is_active = 1",
    draft.toUserId,
  );
  if (!author || !assignee) throw new Error("Mas'ul topilmadi");

  if (
    !(await assignableUsers(author)).some((person) => person.id === assignee.id)
  ) {
    throw new Error("Bu xodimga topshiriq berish huquqi yo'q");
  }

  const seq =
    Number(
      (await get<{ c: number }>("SELECT COUNT(*) AS c FROM tasks"))?.c ?? 0,
    ) + 1;
  const code = `T-${String(seq).padStart(4, "0")}`;
  const stamp = now();

  // One transaction, and a `task_stages` row alongside the task: a plain
  // assignment is a chain of one, and every count over stages — a person's
  // completed total, the team table — would silently miss a task that never
  // got its stage row.
  const taskId = await tx(async (q) => {
    // RETURNING, not a lookup by `code` afterwards: code carries no unique
    // constraint, so that SELECT could hand back another writer's task.
    const newId = await q.insert(
      `INSERT INTO tasks (code, title, description, from_user_id, to_user_id,
                          to_department, priority, status, deadline, uyushma_id, created_at,
                          current_stage, stage_count, reviewer_user_id)
       VALUES (?,?,?,?,?,?,?,'YANGI',?,?,?,1,1,NULL)`,
      code,
      draft.title,
      draft.description ?? null,
      author.id,
      assignee.id,
      assignee.department,
      draft.priority ?? "ORTA",
      draft.deadline ?? null,
      assignee.uyushma_id ?? null,
      stamp,
    );

    await q.run(
      `INSERT INTO task_stages (task_id, position, to_user_id, reviewer_user_id,
                                instruction, status, created_at)
       VALUES (?,1,?,NULL,NULL,'YANGI',?)`,
      newId,
      assignee.id,
      stamp,
    );

    await q.run(
      "INSERT INTO task_events (task_id, user_id, action, comment, created_at, stage_position) VALUES (?,?,'YARATILDI',?,?,1)",
      newId,
      author.id,
      note,
      stamp,
    );

    return newId;
  });

  publish(author.id, assignee.id);
  await notify({
    userId: assignee.id,
    kind: "task",
    title: `${code} · ${draft.title}`,
    body: draft.deadline ? `⏰ ${draft.deadline}` : "",
    href: "/tasks/inbox",
    entity: "task",
    entityId: taskId,
    push: true,
  });

  return { id: taskId, code };
}
