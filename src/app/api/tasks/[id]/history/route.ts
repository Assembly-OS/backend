import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { declineReason, taskHistory } from "@/lib/project-threads";
import { canSeeTask } from "@/lib/task-visibility";
import { id as parseId } from "@/lib/validate";

/**
 * The full record of what happened to one assignment.
 *
 * Fetched on demand rather than loaded with the page: a thread can carry two
 * dozen assignments, and reading every one of their histories to render a
 * panel almost nobody opens would be two dozen queries spent on nothing.
 *
 * Read by whoever `canSeeTask` allows; anyone else is told there is no such
 * task, so an id does not confirm what is behind it.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const taskId = parseId((await params).id);
  if (!taskId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  if (!(await canSeeTask(user, taskId)))
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const [events, reason] = await Promise.all([
    taskHistory(taskId),
    declineReason(taskId),
  ]);
  return NextResponse.json({ events, reason });
}
