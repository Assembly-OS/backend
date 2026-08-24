import { NextResponse } from "next/server";
import { get } from "@/lib/pg";
import { currentUser } from "@/lib/session";
import { hasAdminSession } from "@/lib/admin-auth";
import { taskStages } from "@/lib/queries";
import { seesEverything } from "@/lib/oversight";
import { id as parseId } from "@/lib/validate";

/**
 * Every turn of one assignment: who was asked for what, and what they handed
 * back.
 *
 * Fetched when a card is expanded rather than shipped with the list. A chain
 * of five turns carries five instructions and five results, and a page of
 * thirty cards would be paying for all of it to show the two lines somebody
 * actually opened.
 *
 * Who may read it: anyone the assignment passes through, the person who sent
 * it, whoever reviews the current turn, and the chairman's side of the house.
 * A colleague outside the chain is not shown what a chain of people wrote
 * about their own work.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await hasAdminSession();
  const user = admin ? null : await currentUser();
  if (!admin && !user)
    return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const taskId = parseId((await params).id);
  if (!taskId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const task = await get<{
    from_user_id: number;
    reviewer_user_id: number | null;
  }>(
    "SELECT from_user_id, reviewer_user_id FROM tasks WHERE id = ?",
    taskId,
  );
  if (!task) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const stages = await taskStages(taskId);

  if (user && !seesEverything(user)) {
    const allowed =
      task.from_user_id === user.id ||
      task.reviewer_user_id === user.id ||
      stages.some((stage) => stage.to_user_id === user.id);
    if (!allowed)
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  return NextResponse.json({ stages });
}
