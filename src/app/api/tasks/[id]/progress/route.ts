import { NextResponse } from "next/server";
import { get } from "@/lib/pg";
import { currentUser } from "@/lib/session";
import { publish } from "@/lib/events";
import { addProgress, canReport, progressOf } from "@/lib/task-progress";
import type { Task } from "@/lib/types";
import { canSeeTask } from "@/lib/task-visibility";
import { id as parseId, str } from "@/lib/validate";
import { remember } from "@/lib/knowledge/sources";

type Params = { params: Promise<{ id: string }> };

/**
 * The progress journal of one open-ended assignment, TZ block 3.2.
 *
 * Read by whoever may read the task's own history (`canSeeTask`). Written
 * only by the person holding the work, while it is theirs to move.
 */
export async function GET(_request: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const taskId = parseId((await params).id);
  if (!taskId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  if (!(await canSeeTask(user, taskId)))
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  return NextResponse.json({ entries: await progressOf(taskId) });
}

/** A figure is optional; when given it must be a real number. */
function readMetric(value: unknown): number | null | "BAD" {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  return Number.isFinite(n) ? n : "BAD";
}

export async function POST(request: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const taskId = parseId((await params).id);
  if (!taskId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const task = await get<Task>("SELECT * FROM tasks WHERE id = ?", taskId);
  if (!task) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (task.to_user_id !== user.id)
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  if (!canReport(user.id, task))
    return NextResponse.json({ error: "BAD_STATE" }, { status: 409 });

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const did = str(body.did, 4000);
  const outcome = str(body.outcome, 4000);
  if (!did || !outcome)
    return NextResponse.json({ error: "PROGRESS_REQUIRED" }, { status: 400 });

  const metric = readMetric(body.metric);
  if (metric === "BAD")
    return NextResponse.json({ error: "BAD_METRIC" }, { status: 400 });

  const id = await addProgress(taskId, user.id, {
    did,
    outcome,
    metric,
    blocker: str(body.blocker, 2000),
    help: str(body.help, 2000),
  });

  // The author sees the entry, and a lifted "Jim", without reloading.
  publish(task.from_user_id, task.to_user_id);
  void remember("task", taskId);
  return NextResponse.json({ ok: true, id }, { status: 201 });
}
