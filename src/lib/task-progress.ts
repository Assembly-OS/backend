import { all, get, now } from "./pg";
import { REPORTING_STATUSES } from "./metrics";
import type { Task } from "./types";

/**
 * The progress journal of an open-ended assignment, TZ block 3.2.
 *
 * The person carrying the work writes it piece by piece, at whatever pace the
 * work actually moves — a month on one step and three days on the next five is
 * normal. Each entry is required to say what was done and what it produced;
 * the TZ's "fairness rule" is that on open-ended work a person answers for the
 * effort, not the outcome, and an entry is the record of the effort.
 */

export interface ProgressEntry {
  id: number;
  task_id: number;
  author_id: number;
  author_name: string;
  did: string;
  outcome: string;
  metric: number | null;
  blocker: string | null;
  help_needed: string | null;
  created_at: string;
}

/** Newest first, a hundred at most — a journal is read from its top. */
export async function progressOf(taskId: number): Promise<ProgressEntry[]> {
  return await all<ProgressEntry>(
    `SELECT p.*, u.full_name AS author_name
       FROM task_progress p JOIN users u ON u.id = p.author_id
      WHERE p.task_id = ?
      ORDER BY p.id DESC
      LIMIT 100`,
    taskId,
  );
}

/**
 * Whether this person may write in this task's journal right now: its holder,
 * on open-ended work, while it is theirs to move.
 */
export function canReport(
  userId: number,
  task: Pick<Task, "to_user_id" | "kind" | "status">,
): boolean {
  return (
    task.kind === "MUDDATSIZ" &&
    task.to_user_id === userId &&
    REPORTING_STATUSES.includes(task.status)
  );
}

export async function addProgress(
  taskId: number,
  authorId: number,
  entry: {
    did: string;
    outcome: string;
    metric: number | null;
    blocker: string | null;
    help: string | null;
  },
): Promise<number> {
  const row = await get<{ id: number }>(
    `INSERT INTO task_progress
       (task_id, author_id, did, outcome, metric, blocker, help_needed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
    taskId,
    authorId,
    entry.did,
    entry.outcome,
    entry.metric,
    entry.blocker,
    entry.help,
    now(),
  );
  if (!row) throw new Error("progress entry was not written");
  return row.id;
}
