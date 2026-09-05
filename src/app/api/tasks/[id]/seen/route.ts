import { NextResponse } from "next/server";
import { get, now, run } from "@/lib/pg";
import { currentUser } from "@/lib/session";
import { publish } from "@/lib/events";
import { id as parseId } from "@/lib/validate";

/**
 * Records that the assignee has actually opened the assignment.
 *
 * The gap this fills is the one a manager stares at when nothing has
 * happened: accepted and refused were always recorded, but "he has not even
 * looked at it" was indistinguishable from "he is thinking about it". Those
 * are different conversations.
 *
 * Three rules keep the mark honest:
 *
 *  - **Only the assignee can set it.** Anyone else opening the task — the
 *    author checking on it, an admin reading the list — must not mark it
 *    seen, or the field would record that somebody looked, not that the right
 *    person did.
 *  - **Only the first time.** `seen_at IS NULL` in the WHERE clause, so
 *    reopening the task a week later does not move the timestamp forward and
 *    erase how long the first look actually took.
 *  - **It is not an acceptance.** The status is untouched; accepting stays a
 *    deliberate act with a button behind it. Seeing is not agreeing, and a
 *    platform that conflated them would let work be assigned by ambush.
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
    to_user_id: number;
    from_user_id: number;
    seen_at: string | null;
  }>(
    "SELECT id, to_user_id, from_user_id, seen_at FROM tasks WHERE id = ?",
    taskId,
  );
  if (!task) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  // Not an error: the author opening their own assignment is ordinary, it
  // simply is not evidence of anything and leaves no mark.
  if (task.to_user_id !== user.id || task.seen_at)
    return NextResponse.json({ ok: true, marked: false });

  const stamp = now();
  await run(
    "UPDATE tasks SET seen_at = ? WHERE id = ? AND seen_at IS NULL",
    stamp,
    taskId,
  );
  // Written to the journal as well as the column: the task's own history is
  // where "what happened to this, and when" is read, and a state change
  // missing from it would leave a hole between assigned and accepted.
  await run(
    `INSERT INTO task_events (task_id, user_id, action, comment, created_at, stage_position)
     VALUES (?,?,'KORILDI',NULL,?,NULL)`,
    taskId,
    user.id,
    stamp,
  );

  // The author's view updates without a refresh: this is the one signal they
  // are waiting for.
  publish(task.from_user_id, task.to_user_id);
  return NextResponse.json({ ok: true, marked: true, seen_at: stamp });
}
