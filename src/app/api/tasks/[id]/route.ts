import { NextResponse } from "next/server";
import { get, now, tx } from "@/lib/pg";
import { currentUser } from "@/lib/session";
import { publish } from "@/lib/events";
import { notifyBot } from "@/lib/notify-bot";
import { authorizeTransition, STAGE_STARTED } from "@/lib/task-machine";
import type { Task } from "@/lib/types";

const ERROR_STATUS = { BAD_ACTION: 400, FORBIDDEN: 403, BAD_STATE: 409 } as const;

/** What the handover needs to tell the next person, read inside the same
 *  transaction that moved the work to them. */
interface Handover {
  toUserId: number;
  reviewerUserId: number | null;
  position: number;
  prevName: string;
  prevResult: string | null;
}

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

  const task = await get<Task>("SELECT * FROM tasks WHERE id = ?", taskId);
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
  const stage = task.current_stage;

  /**
   * Every write goes through one transaction, chain or not.
   *
   * Even a plain assignment now touches two tables — the task and the row
   * mirroring its stage — and a failure between them would leave the card
   * showing one person while the buttons authorise another.
   */
  const handover = await tx<Handover | null>(async (q) => {
    if (decision.advance) {
      // Approving the middle of a chain: close this turn, open the next one,
      // and move the mirror. `deadline` is never rewritten — it belongs to the
      // whole chain, which is what keeps "overdue" meaning one thing on the
      // card, in the counters and in the reports.
      const prev = await q.get<{ full_name: string }>(
        "SELECT u.full_name FROM users u WHERE u.id = ?",
        task.to_user_id,
      );

      await q.run(
        "UPDATE task_stages SET status = 'BAJARILDI', closed_at = ? WHERE task_id = ? AND position = ?",
        stamp,
        taskId,
        stage,
      );

      // Read the next holder before the mirror moves, so `to_department` and
      // `uyushma_id` follow the person actually holding the work.
      const next = await q.get<{
        to_user_id: number;
        reviewer_user_id: number | null;
        department: string | null;
        uyushma_id: number | null;
      }>(
        `SELECT s.to_user_id, s.reviewer_user_id, u.department, u.uyushma_id
           FROM task_stages s JOIN users u ON u.id = s.to_user_id
          WHERE s.task_id = ? AND s.position = ?`,
        taskId,
        stage + 1,
      );
      // stage_count said there is another turn; if the row is missing the
      // mirror is already broken and writing more would deepen it.
      if (!next) throw new Error(`task ${taskId}: stage ${stage + 1} missing`);

      await q.run(
        "UPDATE task_stages SET status = 'YANGI' WHERE task_id = ? AND position = ?",
        taskId,
        stage + 1,
      );

      await q.run(
        `UPDATE tasks SET current_stage = ?, to_user_id = ?, to_department = ?,
                          uyushma_id = ?, reviewer_user_id = ?, status = 'YANGI',
                          accepted_at = NULL, submitted_at = NULL, result_comment = NULL
          WHERE id = ?`,
        stage + 1,
        next.to_user_id,
        next.department,
        next.uyushma_id ?? null,
        next.reviewer_user_id,
        taskId,
      );

      // Two entries: whoever approved closed stage k, and stage k+1 opened.
      await q.run(
        "INSERT INTO task_events (task_id, user_id, action, comment, created_at, stage_position) VALUES (?,?,?,?,?,?)",
        taskId,
        user.id,
        decision.event,
        text,
        stamp,
        stage,
      );
      await q.run(
        "INSERT INTO task_events (task_id, user_id, action, comment, created_at, stage_position) VALUES (?,?,?,NULL,?,?)",
        taskId,
        user.id,
        STAGE_STARTED,
        stamp,
        stage + 1,
      );

      return {
        toUserId: next.to_user_id,
        reviewerUserId: next.reviewer_user_id,
        position: stage + 1,
        prevName: prev?.full_name ?? "",
        prevResult: task.result_comment,
      };
    }

    // Everything else is what it has always been, applied to whoever holds the
    // task right now — plus the same change written to the stage that mirrors
    // it. `return` deliberately leaves `current_stage` alone: the stage stays
    // current until it is approved, so rework goes back to the person who did
    // the work rather than to the start of the chain.
    const sets: string[] = ["status = ?"];
    const values: (string | number | null)[] = [decision.to];
    const stageSets: string[] = ["status = ?"];
    const stageValues: (string | number | null)[] = [decision.to];

    if (action === "accept") {
      sets.push("accepted_at = ?");
      values.push(stamp);
      stageSets.push("accepted_at = ?");
      stageValues.push(stamp);
    }
    if (action === "submit") {
      sets.push("submitted_at = ?", "result_comment = ?");
      values.push(stamp, text);
      stageSets.push("submitted_at = ?", "result_comment = ?");
      stageValues.push(stamp, text);
    }
    if (action === "approve" || action === "reject") {
      sets.push("closed_at = ?");
      values.push(stamp);
      stageSets.push("closed_at = ?");
      stageValues.push(stamp);
    }
    if (action === "return") {
      sets.push("submitted_at = NULL");
      stageSets.push("submitted_at = NULL");
    }

    values.push(taskId);
    await q.run(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, ...values);

    stageValues.push(taskId, stage);
    await q.run(
      `UPDATE task_stages SET ${stageSets.join(", ")} WHERE task_id = ? AND position = ?`,
      ...stageValues,
    );

    await q.run(
      "INSERT INTO task_events (task_id, user_id, action, comment, created_at, stage_position) VALUES (?,?,?,?,?,?)",
      taskId,
      user.id,
      decision.event,
      text,
      stamp,
      stage,
    );

    return null;
  });

  if (handover) {
    // The new holder, the person who just handed it over, the author and
    // whoever reviews the new stage all see the move at once.
    publish(
      task.from_user_id,
      task.to_user_id,
      user.id,
      handover.toUserId,
      handover.reviewerUserId ?? task.from_user_id,
    );

    // Its own message: "Yangi topshiriq" would be a lie here — the task is not
    // new, it is half done, and what the next person needs first is what the
    // previous one handed in.
    notifyBot(
      handover.toUserId,
      `🔁 <b>Topshiriq sizga o'tdi</b> ${task.code}\n${task.title}\n` +
        `Bosqich ${handover.position}/${task.stage_count}` +
        (handover.prevName ? ` · oldingi: ${handover.prevName}` : "") +
        (handover.prevResult ? `\n${handover.prevResult}` : "") +
        (task.deadline ? `\n⏰ ${task.deadline}` : ""),
    );

    return NextResponse.json({
      ok: true,
      status: decision.to,
      advanced: true,
      stage: handover.position,
    });
  }

  // Both sides of the task (author and assignee) see the new status at once —
  // and the stage's own reviewer, when it has one, or a submitted stage would
  // not appear on the desk of the person who has to approve it.
  publish(
    task.from_user_id,
    task.to_user_id,
    user.id,
    task.reviewer_user_id ?? task.from_user_id,
  );

  return NextResponse.json({ ok: true, status: decision.to });
}
