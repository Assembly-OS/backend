import { NextResponse } from "next/server";
import { get } from "@/lib/pg";
import { currentUser } from "@/lib/session";
import { notify } from "@/lib/notifications";
import { id as parseId } from "@/lib/validate";

/**
 * Nudges the person who has not accepted an assignment yet.
 *
 * Only the author may send it, and only while the assignment is still
 * unaccepted: once somebody has taken the work on, a reminder is no longer a
 * reminder, it is being chased, and the platform should not make that easy.
 *
 * `notify` de-duplicates on `(user, kind, entity, entityId)`, which here is
 * exactly the behaviour wanted — pressing Remind four times in an afternoon
 * leaves one notification, not four. The author is told which of the two
 * happened rather than being shown a success that did nothing.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const taskId = parseId((await params).id);
  if (!taskId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const task = await get<{
    id: number;
    code: string;
    title: string;
    status: string;
    deadline: string | null;
    from_user_id: number;
    to_user_id: number;
  }>(
    `SELECT id, code, title, status, deadline, from_user_id, to_user_id
       FROM tasks WHERE id = ?`,
    taskId,
  );
  if (!task) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  if (task.from_user_id !== user.id)
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  if (task.status !== "YANGI")
    return NextResponse.json({ error: "ALREADY_ANSWERED" }, { status: 409 });

  const sent = await notify({
    userId: task.to_user_id,
    kind: "task",
    title: `${task.code} — ${user.full_name}`,
    body: task.deadline ? `${task.title} · ${task.deadline}` : task.title,
    href: "/tasks/inbox",
    entity: "task-remind",
    entityId: task.id,
    push: true,
  });

  return NextResponse.json({ ok: true, sent });
}
