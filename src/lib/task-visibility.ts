import { get } from "./pg";
import { seesEverything } from "./oversight";
import { projectRights } from "./project-visibility";
import { isExternal, type User } from "./types";

/**
 * Who may read one assignment's record — its history and its progress
 * journal. Until block 4 both answered anyone signed in, which was harmless
 * while every project was open to every member of staff and stopped being so
 * the day projects closed (TZ 4.2): a task id would have read the work of a
 * project its reader cannot open.
 *
 * Allowed: the chairman's side of the house; anyone the assignment passes
 * through (author, holder, reviewer, any turn of its chain); the direct
 * manager of its author or holder, who answers for their work; and, for
 * staff, anyone who can see the project it belongs to — the journal shows its
 * assignments, and opening one's history from there is the point.
 *
 * `null` when there is no such task.
 */
export async function canSeeTask(
  user: User,
  taskId: number,
): Promise<boolean | null> {
  const row = await get<{ involved: boolean; loyiha_id: number | null }>(
    `SELECT t.loyiha_id,
            (t.from_user_id = ? OR t.to_user_id = ? OR t.reviewer_user_id = ?
             OR EXISTS (SELECT 1 FROM task_stages s
                         WHERE s.task_id = t.id
                           AND (s.to_user_id = ? OR s.reviewer_user_id = ?))
             OR EXISTS (SELECT 1 FROM users p
                         WHERE p.manager_id = ?
                           AND p.id IN (t.from_user_id, t.to_user_id))) AS involved
       FROM tasks t WHERE t.id = ?`,
    user.id,
    user.id,
    user.id,
    user.id,
    user.id,
    user.id,
    taskId,
  );
  if (!row) return null;
  if (seesEverything(user) || row.involved) return true;
  if (row.loyiha_id === null || isExternal(user.role)) return false;
  return (await projectRights(user, row.loyiha_id)) !== null;
}
