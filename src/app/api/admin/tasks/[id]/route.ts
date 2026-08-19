import { NextResponse } from "next/server";
import { get, run } from "@/lib/pg";
import { publish } from "@/lib/events";
import { hasAdminSession } from "@/lib/admin-auth";
import { id as parseId } from "@/lib/validate";

/**
 * Removes an assignment from the panel, in any state.
 *
 * There is already a narrower delete on the platform side: the person who sent
 * an assignment may withdraw it while it is still `YANGI`, because until
 * somebody accepts it there is no work to erase. That rule is right for staff
 * and deliberately unhelpful for cleaning up — the moment an assignee touches a
 * task it stops being a slip and becomes part of their record.
 *
 * This is the administrator's version of the same act, and it does cross that
 * line. `task_events` cascades with the row, so the accepted-at, started-at and
 * submitted-at trail goes too; the count is returned to the panel beforehand so
 * "remove something sent by mistake" and "erase what somebody did" do not look
 * identical at the moment of pressing.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await hasAdminSession()))
    return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const taskId = parseId((await params).id);
  if (!taskId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const task = await get<{ id: number; from_user_id: number; to_user_id: number }>(
    "SELECT id, from_user_id, to_user_id FROM tasks WHERE id = ?",
    taskId,
  );
  if (!task) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  await run("DELETE FROM tasks WHERE id = ?", taskId);

  // Both sides lose a row from their lists and their counters, so both need
  // telling — the assignee most of all, since it was on their desk.
  publish(task.from_user_id, task.to_user_id);

  return NextResponse.json({ ok: true });
}
