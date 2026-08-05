import { all, get } from "./db";
import { isManager } from "./types";
import type { Role, TaskRow, User } from "./types";

/**
 * The author's note when they sent the work back — `tasks.result_comment` only
 * ever holds what the *executor* wrote, so without this the "fix these things"
 * message the author typed lived in the audit log and was never shown.
 *
 * Only counted when it postdates the last submission: once the executor hands
 * the work in again, the old objection is answered and stops being an
 * instruction. `idx_events_task(task_id, id)` covers both lookups.
 */
const RETURN_COMMENT = `
  (SELECT e.comment FROM task_events e
    WHERE e.task_id = t.id AND e.action = 'QAYTARILDI'
      AND e.comment IS NOT NULL
      AND e.id > COALESCE((SELECT MAX(e2.id) FROM task_events e2
                            WHERE e2.task_id = t.id AND e2.action = 'TOPSHIRILDI'), 0)
    ORDER BY e.id DESC LIMIT 1)
`;

const TASK_SELECT = `
  SELECT t.*,
         uf.full_name AS from_name, uf.login AS from_login, uf.role AS from_role,
         ut.full_name AS to_name,   ut.login AS to_login,   ut.role AS to_role,
         l.name AS loyiha_name,
         ${RETURN_COMMENT} AS return_comment
  FROM tasks t
  JOIN users uf ON uf.id = t.from_user_id
  JOIN users ut ON ut.id = t.to_user_id
  LEFT JOIN loyihalar l ON l.id = t.loyiha_id
`;

/* ------------------------------------------------------------------ */
/* Task lists — one per page of the assignment pipeline                */
/* ------------------------------------------------------------------ */

/** «Topshiriq qabul qilish» — sent to me, waiting for accept/reject. */
export function inboxTasks(userId: number): TaskRow[] {
  return all<TaskRow>(
    `${TASK_SELECT} WHERE t.to_user_id = ? AND t.status = 'YANGI'
     ORDER BY CASE t.priority WHEN 'KRITIK' THEN 0 WHEN 'YUQORI' THEN 1 WHEN 'ORTA' THEN 2 ELSE 3 END,
              t.created_at DESC`,
    userId,
  );
}

/**
 * «Topshiriqni bajarish» — accepted by me, still open. Newest first: what just
 * landed is what the executor has not seen yet, so it belongs at the top.
 * Priority and lateness are reachable from the filter bar instead of the sort.
 * `id` breaks ties because seeded rows can share a `created_at` second.
 */
export function executeTasks(userId: number): TaskRow[] {
  return all<TaskRow>(
    `${TASK_SELECT} WHERE t.to_user_id = ?
       AND t.status IN ('QABUL_QILINDI','BAJARILMOQDA','QAYTARILDI','TEKSHIRUVDA')
     ORDER BY t.created_at DESC, t.id DESC`,
    userId,
  );
}

/** «Topshiriq berish» — everything I handed out. */
export function assignedTasks(userId: number): TaskRow[] {
  return all<TaskRow>(
    `${TASK_SELECT} WHERE t.from_user_id = ? ORDER BY t.created_at DESC`,
    userId,
  );
}

/** «Ishchilardan qabul qilish» — results submitted to me for approval. */
export function reviewTasks(userId: number): TaskRow[] {
  return all<TaskRow>(
    `${TASK_SELECT} WHERE t.from_user_id = ? AND t.status = 'TEKSHIRUVDA'
     ORDER BY t.submitted_at DESC`,
    userId,
  );
}

/**
 * Past the deadline and still open. Two lists, because the dashboard counts
 * them separately: what I owe someone, and what my people owe me. The
 * predicate is the same one `counters()` uses, so the numbers always agree.
 */
const OVERDUE = `t.deadline IS NOT NULL AND t.deadline < date('now')
                 AND t.status NOT IN ('BAJARILDI','RAD_ETILDI')`;

export function overdueReceived(userId: number): TaskRow[] {
  return all<TaskRow>(
    `${TASK_SELECT} WHERE t.to_user_id = ? AND ${OVERDUE} ORDER BY t.deadline`,
    userId,
  );
}

export function overdueSent(userId: number): TaskRow[] {
  return all<TaskRow>(
    `${TASK_SELECT} WHERE t.from_user_id = ? AND ${OVERDUE} ORDER BY t.deadline`,
    userId,
  );
}

export function taskById(id: number): TaskRow | undefined {
  return get<TaskRow>(`${TASK_SELECT} WHERE t.id = ?`, id);
}

export interface TaskEventRow {
  id: number;
  action: string;
  comment: string | null;
  created_at: string;
  full_name: string;
  login: string;
}

export function taskEvents(taskId: number): TaskEventRow[] {
  return all<TaskEventRow>(
    `SELECT e.id, e.action, e.comment, e.created_at, u.full_name, u.login
     FROM task_events e JOIN users u ON u.id = e.user_id
     WHERE e.task_id = ? ORDER BY e.id`,
    taskId,
  );
}

/* ------------------------------------------------------------------ */
/* People                                                             */
/* ------------------------------------------------------------------ */

export function userById(id: number): User | undefined {
  return get<User>("SELECT * FROM users WHERE id = ?", id);
}

export function userByLogin(login: string): User | undefined {
  return get<User>(
    "SELECT * FROM users WHERE login = ? COLLATE NOCASE AND is_active = 1",
    login,
  );
}

export function rais(): User | undefined {
  return get<User>("SELECT * FROM users WHERE role = 'RAIS' LIMIT 1");
}

export function subordinates(userId: number): User[] {
  return all<User>(
    "SELECT * FROM users WHERE manager_id = ? AND is_active = 1 ORDER BY full_name",
    userId,
  );
}

/** Who this user is allowed to hand an assignment to. */
export function assignableUsers(user: User): User[] {
  if (user.role === "RAIS") {
    return all<User>(
      "SELECT * FROM users WHERE id != ? AND is_active = 1 ORDER BY role, full_name",
      user.id,
    );
  }
  if (user.role === "ISHCHI") {
    // Staff may only report upward, never assign.
    return [];
  }
  // Heads: own staff, plus peer departments and association / project leads.
  return all<User>(
    `SELECT * FROM users
     WHERE is_active = 1 AND id != ?
       AND (manager_id = ?
            OR role IN ('BOLIM_RAHBARI','AI_LAB','UYUSHMA_RAISI','LOYIHA_RAHBARI'))
     ORDER BY CASE WHEN manager_id = ? THEN 0 ELSE 1 END, role, full_name`,
    user.id,
    user.id,
    user.id,
  );
}

export interface DirectoryEntry {
  id: number;
  login: string;
  full_name: string;
  role: Role;
  department: string | null;
  position: string | null;
  /** Bucket used to group the staff directory in the chat rail. */
  group: string;
}

/** Everyone a user can start a conversation with — the whole active staff. */
export function directory(excludeId: number): DirectoryEntry[] {
  return all<DirectoryEntry>(
    `SELECT id, login, full_name, role, department, position,
            CASE role
              WHEN 'RAIS' THEN 'RAIS'
              WHEN 'LOYIHA_RAHBARI' THEN 'LOYIHA'
              WHEN 'UYUSHMA_RAISI' THEN 'UYUSHMA'
              ELSE COALESCE(department, 'RAIS')
            END AS "group"
     FROM users
     WHERE is_active = 1 AND id != ?
     ORDER BY CASE role
                WHEN 'RAIS' THEN 0 WHEN 'BOLIM_RAHBARI' THEN 1 WHEN 'AI_LAB' THEN 2
                ELSE 3 END,
              full_name`,
    excludeId,
  );
}

/* ------------------------------------------------------------------ */
/* Dashboard counters                                                 */
/* ------------------------------------------------------------------ */

export interface Counters {
  incoming: number;
  inWork: number;
  onReview: number;
  completed: number;
  overdue: number;
  sent: number;
  /** Of the assignments I handed out: still open / approved / past due. */
  sentActive: number;
  sentDone: number;
  sentOverdue: number;
  unread: number;
  team: number;
}

export function counters(userId: number): Counters {
  const row = get<Counters>(
    `SELECT
       (SELECT COUNT(*) FROM tasks WHERE to_user_id = ? AND status = 'YANGI') AS incoming,
       (SELECT COUNT(*) FROM tasks WHERE to_user_id = ? AND status IN ('QABUL_QILINDI','BAJARILMOQDA','QAYTARILDI')) AS inWork,
       (SELECT COUNT(*) FROM tasks WHERE from_user_id = ? AND status = 'TEKSHIRUVDA') AS onReview,
       (SELECT COUNT(*) FROM tasks WHERE to_user_id = ? AND status = 'BAJARILDI') AS completed,
       (SELECT COUNT(*) FROM tasks WHERE to_user_id = ? AND deadline IS NOT NULL AND deadline < date('now')
          AND status NOT IN ('BAJARILDI','RAD_ETILDI')) AS overdue,
       (SELECT COUNT(*) FROM tasks WHERE from_user_id = ?) AS sent,
       (SELECT COUNT(*) FROM tasks WHERE from_user_id = ? AND status NOT IN ('BAJARILDI','RAD_ETILDI')) AS sentActive,
       (SELECT COUNT(*) FROM tasks WHERE from_user_id = ? AND status = 'BAJARILDI') AS sentDone,
       (SELECT COUNT(*) FROM tasks WHERE from_user_id = ? AND deadline IS NOT NULL AND deadline < date('now')
          AND status NOT IN ('BAJARILDI','RAD_ETILDI')) AS sentOverdue,
       (SELECT COUNT(*) FROM messages WHERE to_user_id = ? AND read_at IS NULL) AS unread,
       (SELECT COUNT(*) FROM users WHERE manager_id = ? AND is_active = 1) AS team`,
    userId,
    userId,
    userId,
    userId,
    userId,
    userId,
    userId,
    userId,
    userId,
    userId,
    userId,
  );
  return (
    row ?? {
      incoming: 0,
      inWork: 0,
      onReview: 0,
      completed: 0,
      overdue: 0,
      sent: 0,
      sentActive: 0,
      sentDone: 0,
      sentOverdue: 0,
      unread: 0,
      team: 0,
    }
  );
}

/**
 * Cheap "has anything changed for me?" probe the client polls while a page is
 * open. Every assignment and every pipeline transition writes a `task_events`
 * row, so the highest event id on my tasks is a complete revision marker —
 * when it moves, the page I am looking at is stale and must be re-rendered.
 */
export interface Pulse {
  taskRev: number;
  /**
   * Latest event anywhere in the organisation. The dashboard charts and the
   * statistics page summarise everyone's work, so a manager's page goes stale
   * from activity that never touches them personally — `taskRev` alone would
   * never notice. Zero for staff, who see no organisation-wide figures.
   */
  orgRev: number;
  msgRev: number;
  incoming: number;
  inWork: number;
  onReview: number;
  unread: number;
}

export function pulse(user: User): Pulse {
  const userId = user.id;
  const mine = get<Omit<Pulse, "orgRev">>(
    `SELECT
       (SELECT COALESCE(MAX(e.id), 0) FROM task_events e
          JOIN tasks t ON t.id = e.task_id
          WHERE t.to_user_id = ? OR t.from_user_id = ?) AS taskRev,
       (SELECT COALESCE(MAX(id), 0) FROM messages
          WHERE to_user_id = ? OR from_user_id = ?) AS msgRev,
       (SELECT COUNT(*) FROM tasks WHERE to_user_id = ? AND status = 'YANGI') AS incoming,
       (SELECT COUNT(*) FROM tasks WHERE to_user_id = ? AND status IN ('QABUL_QILINDI','BAJARILMOQDA','QAYTARILDI')) AS inWork,
       (SELECT COUNT(*) FROM tasks WHERE from_user_id = ? AND status = 'TEKSHIRUVDA') AS onReview,
       (SELECT COUNT(*) FROM messages WHERE to_user_id = ? AND read_at IS NULL) AS unread`,
    userId,
    userId,
    userId,
    userId,
    userId,
    userId,
    userId,
    userId,
  )!;

  const orgRev = isManager(user.role)
    ? Number(
        get<{ rev: number }>(
          "SELECT COALESCE(MAX(id), 0) AS rev FROM task_events",
        )?.rev ?? 0,
      )
    : 0;

  return { ...mine, orgRev };
}

export function recentTasks(userId: number, limit = 6): TaskRow[] {
  return all<TaskRow>(
    `${TASK_SELECT} WHERE t.to_user_id = ? OR t.from_user_id = ?
     ORDER BY t.created_at DESC LIMIT ?`,
    userId,
    userId,
    limit,
  );
}

/* ------------------------------------------------------------------ */
/* Organisation-wide analytics (Rais command centre + statistics)      */
/* ------------------------------------------------------------------ */

export interface OrgTotals {
  users: number;
  uyushmalar: number;
  loyihalar: number;
  tasks: number;
  done: number;
  overdue: number;
  members: number;
  budget: number;
}

export function orgTotals(): OrgTotals {
  return get<OrgTotals>(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE is_active = 1) AS users,
       (SELECT COUNT(*) FROM uyushmalar) AS uyushmalar,
       (SELECT COUNT(*) FROM loyihalar) AS loyihalar,
       (SELECT COUNT(*) FROM tasks) AS tasks,
       (SELECT COUNT(*) FROM tasks WHERE status = 'BAJARILDI') AS done,
       (SELECT COUNT(*) FROM tasks WHERE deadline IS NOT NULL AND deadline < date('now')
          AND status NOT IN ('BAJARILDI','RAD_ETILDI')) AS overdue,
       (SELECT COALESCE(SUM(members_count),0) FROM uyushmalar) AS members,
       (SELECT COALESCE(SUM(budget),0) FROM loyihalar) AS budget`,
  )!;
}

export interface DeptStat {
  department: string;
  head_name: string | null;
  head_login: string | null;
  staff: number;
  total: number;
  done: number;
  active: number;
  overdue: number;
}

export function departmentStats(): DeptStat[] {
  return all<DeptStat>(
    `SELECT d.department,
            h.full_name AS head_name,
            h.login AS head_login,
            (SELECT COUNT(*) FROM users s WHERE s.department = d.department AND s.role = 'ISHCHI' AND s.is_active = 1) AS staff,
            (SELECT COUNT(*) FROM tasks t WHERE t.to_department = d.department) AS total,
            (SELECT COUNT(*) FROM tasks t WHERE t.to_department = d.department AND t.status = 'BAJARILDI') AS done,
            (SELECT COUNT(*) FROM tasks t WHERE t.to_department = d.department AND t.status IN ('YANGI','QABUL_QILINDI','BAJARILMOQDA','TEKSHIRUVDA')) AS active,
            (SELECT COUNT(*) FROM tasks t WHERE t.to_department = d.department AND t.deadline < date('now') AND t.status NOT IN ('BAJARILDI','RAD_ETILDI')) AS overdue
     FROM (SELECT 'GR' AS department UNION ALL SELECT 'FR' UNION ALL SELECT 'BR'
           UNION ALL SELECT 'PR' UNION ALL SELECT 'AI_LAB') d
     LEFT JOIN users h ON h.department = d.department AND h.role IN ('BOLIM_RAHBARI','AI_LAB')`,
  );
}

export interface UyushmaStat {
  id: number;
  name: string;
  short_name: string;
  sector: string;
  region: string;
  members_count: number;
  head_name: string | null;
  head_login: string | null;
  projects: number;
  budget: number;
  tasks_total: number;
  tasks_done: number;
  tasks_active: number;
  tasks_overdue: number;
}

export function uyushmaStats(): UyushmaStat[] {
  return all<UyushmaStat>(
    `SELECT u.id, u.name, u.short_name, u.sector, u.region, u.members_count,
            h.full_name AS head_name, h.login AS head_login,
            (SELECT COUNT(*) FROM loyihalar l WHERE l.uyushma_id = u.id) AS projects,
            (SELECT COALESCE(SUM(l.budget),0) FROM loyihalar l WHERE l.uyushma_id = u.id) AS budget,
            (SELECT COUNT(*) FROM tasks t WHERE t.uyushma_id = u.id) AS tasks_total,
            (SELECT COUNT(*) FROM tasks t WHERE t.uyushma_id = u.id AND t.status = 'BAJARILDI') AS tasks_done,
            (SELECT COUNT(*) FROM tasks t WHERE t.uyushma_id = u.id AND t.status IN ('YANGI','QABUL_QILINDI','BAJARILMOQDA','TEKSHIRUVDA')) AS tasks_active,
            (SELECT COUNT(*) FROM tasks t WHERE t.uyushma_id = u.id AND t.deadline < date('now') AND t.status NOT IN ('BAJARILDI','RAD_ETILDI')) AS tasks_overdue
     FROM uyushmalar u
     LEFT JOIN users h ON h.id = u.head_user_id
     ORDER BY u.name`,
  );
}

export interface StatusSlice {
  status: string;
  count: number;
}

export function taskStatusBreakdown(uyushmaId?: number): StatusSlice[] {
  return uyushmaId
    ? all<StatusSlice>(
        "SELECT status, COUNT(*) AS count FROM tasks WHERE uyushma_id = ? GROUP BY status",
        uyushmaId,
      )
    : all<StatusSlice>(
        "SELECT status, COUNT(*) AS count FROM tasks GROUP BY status",
      );
}

export interface ProjectRow {
  id: number;
  code: string;
  name: string;
  status: string;
  progress: number;
  budget: number;
  deadline: string | null;
  owner_name: string | null;
  owner_login: string | null;
  uyushma_name: string | null;
}

export function projects(): ProjectRow[] {
  return all<ProjectRow>(
    `SELECT l.id, l.code, l.name, l.status, l.progress, l.budget, l.deadline,
            o.full_name AS owner_name, o.login AS owner_login, u.name AS uyushma_name
     FROM loyihalar l
     LEFT JOIN users o ON o.id = l.owner_id
     LEFT JOIN uyushmalar u ON u.id = l.uyushma_id
     ORDER BY l.progress DESC`,
  );
}

/* ------------------------------------------------------------------ */
/* Team performance                                                   */
/* ------------------------------------------------------------------ */

export interface TeamMemberStat extends User {
  total: number;
  done: number;
  active: number;
  overdue: number;
}

export function teamStats(managerId: number): TeamMemberStat[] {
  return all<TeamMemberStat>(
    `SELECT u.*,
            (SELECT COUNT(*) FROM tasks t WHERE t.to_user_id = u.id) AS total,
            (SELECT COUNT(*) FROM tasks t WHERE t.to_user_id = u.id AND t.status = 'BAJARILDI') AS done,
            (SELECT COUNT(*) FROM tasks t WHERE t.to_user_id = u.id AND t.status IN ('YANGI','QABUL_QILINDI','BAJARILMOQDA','TEKSHIRUVDA')) AS active,
            (SELECT COUNT(*) FROM tasks t WHERE t.to_user_id = u.id AND t.deadline < date('now') AND t.status NOT IN ('BAJARILDI','RAD_ETILDI')) AS overdue
     FROM users u WHERE u.manager_id = ? AND u.is_active = 1
     ORDER BY u.full_name`,
    managerId,
  );
}

/* ------------------------------------------------------------------ */
/* Chat                                                               */
/* ------------------------------------------------------------------ */

export interface Conversation {
  id: number;
  login: string;
  full_name: string;
  role: Role;
  department: string | null;
  position: string | null;
  last_body: string;
  last_at: string;
  last_from: number;
  unread: number;
}

export function conversations(userId: number): Conversation[] {
  return all<Conversation>(
    `WITH partners AS (
       SELECT CASE WHEN from_user_id = ? THEN to_user_id ELSE from_user_id END AS pid,
              MAX(id) AS last_id
       FROM messages
       WHERE from_user_id = ? OR to_user_id = ?
       GROUP BY pid
     )
     SELECT u.id, u.login, u.full_name, u.role, u.department, u.position,
            m.body AS last_body, m.created_at AS last_at, m.from_user_id AS last_from,
            (SELECT COUNT(*) FROM messages x
              WHERE x.from_user_id = u.id AND x.to_user_id = ? AND x.read_at IS NULL) AS unread
     FROM partners p
     JOIN users u ON u.id = p.pid
     JOIN messages m ON m.id = p.last_id
     ORDER BY m.id DESC`,
    userId,
    userId,
    userId,
    userId,
  );
}

export interface ChatMessage {
  id: number;
  from_user_id: number;
  to_user_id: number;
  body: string;
  created_at: string;
  read_at: string | null;
}

/** The ids of everyone this user has exchanged messages with. */
export function conversationPartnerIds(userId: number): number[] {
  return all<{ id: number }>(
    `SELECT DISTINCT
       CASE WHEN from_user_id = ? THEN to_user_id ELSE from_user_id END AS id
     FROM messages
     WHERE from_user_id = ? OR to_user_id = ?`,
    userId,
    userId,
    userId,
  ).map((row) => row.id);
}

/** How many messages one thread page holds. */
export const THREAD_PAGE = 50;

/**
 * A page of a conversation, newest `THREAD_PAGE` by default, returned in
 * ascending (display) order. Pass `before` — the oldest id currently shown — to
 * fetch the previous page, so long threads load lazily instead of all at once.
 */
export function thread(
  userId: number,
  otherId: number,
  opts: { before?: number; limit?: number } = {},
): ChatMessage[] {
  const limit = opts.limit ?? THREAD_PAGE;
  const params: (number | null)[] = [userId, otherId, otherId, userId];
  if (opts.before) params.push(opts.before);
  params.push(limit);

  // Take the newest `limit` (optionally older than `before`), then flip to
  // ascending so the caller renders oldest → newest.
  const rows = all<ChatMessage>(
    `SELECT * FROM messages
     WHERE ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))
       ${opts.before ? "AND id < ?" : ""}
     ORDER BY id DESC
     LIMIT ?`,
    ...params,
  );
  return rows.reverse();
}
