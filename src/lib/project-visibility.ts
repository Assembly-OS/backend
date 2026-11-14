import { all, get, run, type Param } from "./pg";
import { reach } from "./permissions";
import { isExternal, type User } from "./types";

/**
 * Which projects a person can see, and what they may do in one (TZ 4.2).
 *
 * Until block 4 every project was open to everyone signed in, on purpose —
 * see the note in `project-access.ts` — and the first outside project lead
 * would have read every project in the Assembly. The owner chose to close it
 * the way the TZ prints it: the chairman sees all, a department head the
 * projects his department works on, a cluster head his cluster, everyone
 * else the projects they are attached to.
 *
 * "Attached" is the project's owner, its deputy, or a row in
 * `project_members`. The schema attached everyone the record already showed
 * at work on a project before the doors closed, and assigning work on a
 * project attaches its assignee from then on.
 *
 * Every read of project data goes through `projectScope` (lists) or
 * `projectRights` (one project) — including the routes addressed by a
 * thread's or an entry's id, which resolve their project first. A project
 * outside the scope does not exist for that person: pages answer 404, not
 * 403, so a link does not even confirm what is behind it.
 */

/** Ids come from the session or the database; inlining one is safe. */
function int(value: number): number {
  if (!Number.isInteger(value)) throw new Error("not an id");
  return value;
}

/** SQL: `who` (an id expression) is attached to the project `alias`. */
function attachedSql(who: string, alias: string): string {
  return `(${alias}.owner_id = ${who} OR ${alias}.deputy_id = ${who}
           OR EXISTS (SELECT 1 FROM project_members pm
                       WHERE pm.project_id = ${alias}.id AND pm.user_id = ${who}))`;
}

/** What scoping needs to know about a person; a full `User` will do. */
export type Viewer = Pick<User, "id" | "role" | "login" | "department" | "klaster_id">;

/**
 * A WHERE fragment limiting `alias` (a `loyihalar` row) to what `user` may
 * see, with its parameters.
 */
export function projectScope(
  user: Viewer,
  alias = "l",
): { sql: string; params: Param[] } {
  const self = String(int(user.id));
  switch (reach(user, "viewProjects")) {
    case "yes":
      return { sql: "TRUE", params: [] };
    case "department": {
      // Anyone in the head's department, anyone reporting to him, and him.
      // A head with no department still has his own reports.
      const department = user.department
        ? "OR dm.department = ?"
        : "";
      return {
        sql: `EXISTS (SELECT 1 FROM users dm
                       WHERE (dm.id = ${self} OR dm.manager_id = ${self} ${department})
                         AND ${attachedSql("dm.id", alias)})`,
        params: user.department ? [user.department] : [],
      };
    }
    case "cluster":
      return {
        sql: `(${alias}.klaster_id = ? OR ${attachedSql(self, alias)})`,
        // No cluster yet: an id no cluster has, so only attachment counts.
        params: [user.klaster_id ?? -1],
      };
    case "own":
    case "attached":
      return { sql: attachedSql(self, alias), params: [] };
    default:
      return { sql: "FALSE", params: [] };
  }
}

/** What one person may do in one project. */
export interface ProjectRights {
  id: number;
  owner_id: number | null;
  deputy_id: number | null;
  /** Leads it (owner or deputy) or has a row in `project_members`. */
  attached: boolean;
  editPassport: boolean;
  enterStages: boolean;
  /** Adding and removing the passport's documents. */
  keepDocuments: boolean;
  /** Journal threads, members, the project's meetings: staff only. */
  internal: boolean;
}

/**
 * The person's rights in a project, or null when the project does not exist
 * for them — missing, or outside their scope. Callers answer 404 on null.
 */
export async function projectRights(
  user: Viewer,
  projectId: number,
): Promise<ProjectRights | null> {
  const scope = projectScope(user);
  const row = await get<{
    id: number;
    owner_id: number | null;
    deputy_id: number | null;
    visible: boolean;
    attached: boolean;
  }>(
    `SELECT l.id, l.owner_id, l.deputy_id,
            (${scope.sql}) AS visible,
            ${attachedSql(String(int(user.id)), "l")} AS attached
       FROM loyihalar l WHERE l.id = ?`,
    ...scope.params,
    projectId,
  );
  if (!row || !row.visible) return null;

  const leads = row.owner_id === user.id || row.deputy_id === user.id;
  const passport = reach(user, "editPassport");
  const editPassport =
    passport === "yes" || (passport === "own" && row.attached);
  const stages = reach(user, "enterStageStatus");
  // The owner and deputy lead the project whatever their role says, and the
  // schedule is theirs to keep — that was the rule before the table, and a
  // deputy who is on the staff list as an employee still runs the work.
  const enterStages =
    stages === "yes" || (stages === "own" && row.attached) || leads;

  return {
    id: row.id,
    owner_id: row.owner_id,
    deputy_id: row.deputy_id,
    attached: row.attached,
    editPassport,
    enterStages,
    // 4.3 lets the outside lead attach files; whoever keeps the passport or
    // the schedule keeps its documents.
    keepDocuments: editPassport || enterStages,
    // An outside lead sees the card — passport, schedule, documents — and
    // not the staff's journal, meetings or task pulse (4.1: "status and
    // report only").
    internal: !isExternal(user.role),
  };
}

/**
 * Of `ids`, the projects this person can see — for forms that link a record
 * to projects. An id outside the scope is dropped, the same as one that does
 * not exist.
 */
export async function visibleProjectIds(
  user: Viewer,
  ids: number[],
): Promise<number[]> {
  if (ids.length === 0) return [];
  const scope = projectScope(user);
  const rows = await all<{ id: number }>(
    `SELECT l.id FROM loyihalar l
      WHERE l.id IN (${ids.map(() => "?").join(",")}) AND ${scope.sql}`,
    ...ids,
    ...scope.params,
  );
  return rows.map((row) => row.id);
}

/** The projects this person can see, as options for a picker. */
export async function projectOptions(
  user: Viewer,
): Promise<{ id: number; code: string; name: string }[]> {
  const scope = projectScope(user);
  return await all<{ id: number; code: string; name: string }>(
    `SELECT l.id, l.code, l.name FROM loyihalar l WHERE ${scope.sql} ORDER BY l.code`,
    ...scope.params,
  );
}

/** The project a journal thread belongs to, or null. */
export async function projectOfThread(threadId: number): Promise<number | null> {
  return (
    (await get<{ project_id: number }>(
      "SELECT project_id FROM project_threads WHERE id = ?",
      threadId,
    ))?.project_id ?? null
  );
}

/** The project a journal entry belongs to, or null. */
export async function projectOfEntry(entryId: number): Promise<number | null> {
  return (
    (await get<{ project_id: number }>(
      `SELECT th.project_id FROM thread_entries e
         JOIN project_threads th ON th.id = e.thread_id
        WHERE e.id = ?`,
      entryId,
    ))?.project_id ?? null
  );
}

/** Rights in the project a thread belongs to; null if unseen or missing. */
export async function threadRights(
  user: Viewer,
  threadId: number,
): Promise<ProjectRights | null> {
  const projectId = await projectOfThread(threadId);
  return projectId === null ? null : await projectRights(user, projectId);
}

/** Rights in the project an entry belongs to; null if unseen or missing. */
export async function entryRights(
  user: Viewer,
  entryId: number,
): Promise<ProjectRights | null> {
  const projectId = await projectOfEntry(entryId);
  return projectId === null ? null : await projectRights(user, projectId);
}

/**
 * Attaches a person to a project; a no-op if they already are. Called when
 * work on the project is assigned to them, and from the project's members
 * panel.
 */
export async function attach(
  projectId: number,
  userId: number,
  addedBy: number | null,
): Promise<void> {
  await run(
    `INSERT INTO project_members (project_id, user_id, added_by)
     SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM loyihalar WHERE id = ?)
     ON CONFLICT DO NOTHING`,
    projectId,
    userId,
    addedBy,
    projectId,
  );
}

export interface ProjectMember {
  user_id: number;
  full_name: string;
  login: string;
  role: User["role"];
  /** How they are attached: leading it, or by a membership row. */
  via: "owner" | "deputy" | "member";
}

/** Everyone attached to a project, leads first. */
export async function membersOf(projectId: number): Promise<ProjectMember[]> {
  return await all<ProjectMember>(
    `SELECT u.id AS user_id, u.full_name, u.login, u.role,
            CASE WHEN l.owner_id = u.id THEN 'owner'
                 WHEN l.deputy_id = u.id THEN 'deputy'
                 ELSE 'member' END AS via
       FROM loyihalar l
       JOIN users u ON u.id = l.owner_id OR u.id = l.deputy_id
                    OR u.id IN (SELECT user_id FROM project_members WHERE project_id = l.id)
      WHERE l.id = ? AND u.is_active = 1
      ORDER BY CASE WHEN l.owner_id = u.id THEN 0 WHEN l.deputy_id = u.id THEN 1 ELSE 2 END,
               u.full_name`,
    projectId,
  );
}

/**
 * Who can be attached to a project: the staff who take work, and outside
 * project leads. Not the chairman, who sees every project already, and not
 * the association roles, whose column in TZ 4.2 has no projects at all.
 */
export async function memberCandidates(): Promise<
  { id: number; full_name: string; role: User["role"] }[]
> {
  return await all<{ id: number; full_name: string; role: User["role"] }>(
    `SELECT id, full_name, role FROM users
      WHERE is_active = 1 AND role NOT IN ('RAIS', 'UYUSHMA_RAISI', 'UYUSHMA_VAKILI')
      ORDER BY full_name`,
  );
}
