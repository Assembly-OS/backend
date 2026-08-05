import { NextResponse } from "next/server";
import { get, now, run } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { publish } from "@/lib/events";
import { authorizeTransition } from "@/lib/task-machine";
import type { Task } from "@/lib/types";

const ERROR_STATUS = { BAD_ACTION: 400, FORBIDDEN: 403, BAD_STATE: 409 } as const;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const { id } = await params;
  const taskId = Number(id);
  const { action, comment } = (await request.json()) as {
    action?: string;
    comment?: string;
  };

  const task = get<Task>("SELECT * FROM tasks WHERE id = ?", taskId);
  if (!task) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const decision = authorizeTransition(action ?? "", task, user.id);
  if (!decision.ok) {
    return NextResponse.json(
      { error: decision.error },
      { status: ERROR_STATUS[decision.error] },
    );
  }

  const stamp = now();
  const text = comment?.trim() || null;

  const sets: string[] = ["status = ?"];
  const values: (string | number | null)[] = [decision.to];

  if (action === "accept") {
    sets.push("accepted_at = ?");
    values.push(stamp);
  }
  if (action === "submit") {
    sets.push("submitted_at = ?", "result_comment = ?");
    values.push(stamp, text);
  }
  if (action === "approve" || action === "reject") {
    sets.push("closed_at = ?");
    values.push(stamp);
  }
  if (action === "return") {
    sets.push("submitted_at = NULL");
  }

  values.push(taskId);
  run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, ...values);
  run(
    "INSERT INTO task_events (task_id, user_id, action, comment, created_at) VALUES (?,?,?,?,?)",
    taskId,
    user.id,
    decision.event,
    text,
    stamp,
  );

  // Both sides of the task (author and assignee) see the new status at once.
  publish(task.from_user_id, task.to_user_id, user.id);

  return NextResponse.json({ ok: true, status: decision.to });
}
