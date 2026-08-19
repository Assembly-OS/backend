import { NextResponse } from "next/server";
import { get, run } from "@/lib/pg";
import { currentUser } from "@/lib/session";
import { publish } from "@/lib/events";
import { id as parseId } from "@/lib/validate";

/**
 * Withdrawing an assignment sent by mistake.
 *
 * Deliberately narrow: only the person who sent it (or the chairman), and only
 * while it is still `YANGI` — nobody has accepted it, nobody has started, there
 * is no work to erase. The moment the assignee touches it the task stops being
 * a slip and becomes part of their record; from there the honest move is to
 * close it with a comment, which the normal actions already do.
 *
 * A real delete rather than a hidden flag: an assignment that was never meant
 * to exist should not sit in anyone's history as a thing that was cancelled,
 * and the alternative — a `deleted_at` column — would have to be honoured by
 * every query in the platform for the rest of its life.
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
    from_user_id: number;
    to_user_id: number;
    status: string;
    current_stage: number;
  }>(
    "SELECT id, from_user_id, to_user_id, status, current_stage FROM tasks WHERE id = ?",
    taskId,
  );

  if (!task) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (task.from_user_id !== user.id && user.role !== "RAIS")
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  // `current_stage` as well as the status: a chain whose second turn is YANGI
  // has a first participant who already finished their part, and withdrawing
  // it would erase their work along with the audit rows that recorded it.
  if (task.status !== "YANGI" || task.current_stage !== 1)
    return NextResponse.json({ error: "ALREADY_STARTED" }, { status: 409 });

  // The notification goes with it: a bell that opens a task which no longer
  // exists is worse than no bell at all.
  await run("DELETE FROM notifications WHERE entity = 'task' AND entity_id = ?", taskId);
  await run("DELETE FROM task_events WHERE task_id = ?", taskId);
  // The agreement it may have been raised from survives — the commitment was
  // real even if the assignment carrying it was a misfire.
  await run("UPDATE agreements SET task_id = NULL WHERE task_id = ?", taskId);
  // `task_stages` goes with it through ON DELETE CASCADE.
  await run("DELETE FROM tasks WHERE id = ?", taskId);

  publish(task.from_user_id, task.to_user_id);
  return NextResponse.json({ ok: true });
}
