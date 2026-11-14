import { get } from "./pg";
import { openSql } from "./metrics";
import type { PriorityRoom } from "./priority-rules";

export {
  KRITIK_LIMIT,
  YUQORI_SHARE,
  priorityRefusal,
  type PriorityRefusal,
  type PriorityRoom,
} from "./priority-rules";

/**
 * The counts the priority rule is judged against, for one author. Open work
 * only — "open" as `metrics.ts` defines it, returned work included — because
 * a limit on urgency is about what is still waiting, not about history.
 */
export async function priorityRoom(authorId: number): Promise<PriorityRoom> {
  const row = await get<PriorityRoom>(
    `SELECT
       (SELECT COUNT(*) FROM tasks WHERE priority = 'KRITIK' AND ${openSql()}) AS "kritikOpen",
       (SELECT COUNT(*) FROM tasks WHERE from_user_id = ? AND ${openSql()}) AS "authorOpen",
       (SELECT COUNT(*) FROM tasks WHERE from_user_id = ? AND priority = 'YUQORI'
          AND ${openSql()}) AS "authorHigh"`,
    authorId,
    authorId,
  );
  return row ?? { kritikOpen: 0, authorOpen: 0, authorHigh: 0 };
}
