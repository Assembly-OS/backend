import { all, get, now, run } from "./pg";
import { isManager } from "./types";
import type {
  MessageKind,
  QueuedTaskRow,
  Role,
  TaskRow,
  TaskStage,
  User,
} from "./types";

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

/**
 * Three joins that are NULL on almost every row, and that is the deal.
 *
 * A chain keeps `tasks` as the mirror of whichever stage is current, so every
 * other query in this file — inbox, execute, sent, overdue, the dashboards —
 * goes on meaning exactly what it meant before. The price is paid once, here:
 * the current stage's own instruction, what the previous person handed in, and
 * the names for the progress strip. On a one-stage assignment all four come
 * back NULL and the UI shows nothing new.
 */
const TASK_SELECT = `
  SELECT t.*,
         uf.full_name AS from_name, uf.login AS from_login, uf.role AS from_role,
         ut.full_name AS to_name,   ut.login AS to_login,   ut.role AS to_role,
         l.name AS loyiha_name,
         cs.instruction    AS stage_instruction,
         ps.result_comment AS prev_result_comment,
         pu.full_name      AS prev_stage_name,
         (SELECT string_agg(su.full_name, ',' ORDER BY s2.position)
            FROM task_stages s2 JOIN users su ON su.id = s2.to_user_id
           WHERE s2.task_id = t.id AND t.stage_count > 1) AS stage_names,
         ${RETURN_COMMENT} AS return_comment
  FROM tasks t
  JOIN users uf ON uf.id = t.from_user_id
  JOIN users ut ON ut.id = t.to_user_id
  LEFT JOIN loyihalar l ON l.id = t.loyiha_id
  LEFT JOIN task_stages cs ON cs.task_id = t.id AND cs.position = t.current_stage
  LEFT JOIN task_stages ps ON ps.task_id = t.id AND ps.position = t.current_stage - 1
  LEFT JOIN users pu ON pu.id = ps.to_user_id
`;

/* ------------------------------------------------------------------ */
/* Task lists — one per page of the assignment pipeline                */
/* ------------------------------------------------------------------ */

/** «Topshiriq qabul qilish» — sent to me, waiting for accept/reject. */
export async function inboxTasks(userId: number): Promise<TaskRow[]> {
  return await all<TaskRow>(
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
export async function executeTasks(userId: number): Promise<TaskRow[]> {
  return await all<TaskRow>(
    `${TASK_SELECT} WHERE t.to_user_id = ?
       AND t.status IN ('QABUL_QILINDI','BAJARILMOQDA','QAYTARILDI','TEKSHIRUVDA')
     ORDER BY t.created_at DESC, t.id DESC`,
    userId,
  );
}

/** «Topshiriq berish» — everything I handed out. */
export async function assignedTasks(userId: number): Promise<TaskRow[]> {
  return await all<TaskRow>(
    `${TASK_SELECT} WHERE t.from_user_id = ? ORDER BY t.created_at DESC`,
    userId,
  );
}

/**
 * «Ishchilardan qabul qilish» — results submitted to me for approval.
 *
 * COALESCE, not `from_user_id`: when a stage names its own reviewer the work
 * comes to them instead of the author, which is what lets a chain of two run
 * "prepare → check" without a detour.
 */
export async function reviewTasks(userId: number): Promise<TaskRow[]> {
  return await all<TaskRow>(
    `${TASK_SELECT} WHERE COALESCE(t.reviewer_user_id, t.from_user_id) = ?
       AND t.status = 'TEKSHIRUVDA'
     ORDER BY t.submitted_at DESC`,
    userId,
  );
}

/**
 * Stages waiting their turn on this person — read-only, no buttons, in no
 * counter. Nobody should have a half-finished task drop on them out of
 * nowhere; seeing the queue ahead of you is the point of a chain.
 */
export async function queuedTasks(userId: number): Promise<QueuedTaskRow[]> {
  return await all<QueuedTaskRow>(
    `SELECT t.id, t.code, t.title, t.deadline, t.priority,
            t.stage_count, s.position AS stage_position, s.instruction,
            uf.full_name AS from_name, uh.full_name AS holder_name
       FROM task_stages s
       JOIN tasks t  ON t.id = s.task_id
       JOIN users uf ON uf.id = t.from_user_id
       JOIN users uh ON uh.id = t.to_user_id
      WHERE s.to_user_id = ? AND s.status = 'KUTMOQDA'
        AND t.status NOT IN ('BAJARILDI','RAD_ETILDI')
      ORDER BY t.deadline NULLS LAST, s.position`,
    userId,
  );
}

/** Every turn of one task, in order — for the expanded card. */
export async function taskStages(
  taskId: number,
): Promise<(TaskStage & { to_name: string })[]> {
  return await all<TaskStage & { to_name: string }>(
    `SELECT s.*, u.full_name AS to_name
       FROM task_stages s JOIN users u ON u.id = s.to_user_id
      WHERE s.task_id = ? ORDER BY s.position`,
    taskId,
  );
}

/**
 * Past the deadline and still open. Two lists, because the dashboard counts
 * them separately: what I owe someone, and what my people owe me. The
 * predicate is the same one `counters()` uses, so the numbers always agree.
 */
const OVERDUE = `t.deadline IS NOT NULL AND t.deadline < ?
                 AND t.status NOT IN ('BAJARILDI','RAD_ETILDI')`;

/**
 * The bound `date('now')` used to supply. It is computed here rather than in
 * SQL because Postgres's `current_date` follows the server's timezone, while
 * every stored deadline is a UTC 'YYYY-MM-DD' string — comparing the two as
 * text is exactly what SQLite was doing, and stays right only while the bound
 * is UTC too.
 */
const todayUtc = () => now().slice(0, 10);

export async function overdueReceived(userId: number): Promise<TaskRow[]> {
  return await all<TaskRow>(
    `${TASK_SELECT} WHERE t.to_user_id = ? AND ${OVERDUE} ORDER BY t.deadline`,
    userId,
    todayUtc(),
  );
}

export async function overdueSent(userId: number): Promise<TaskRow[]> {
  return await all<TaskRow>(
    `${TASK_SELECT} WHERE t.from_user_id = ? AND ${OVERDUE} ORDER BY t.deadline`,
    userId,
    todayUtc(),
  );
}

export async function taskById(id: number): Promise<TaskRow | undefined> {
  return await get<TaskRow>(`${TASK_SELECT} WHERE t.id = ?`, id);
}

export interface TaskEventRow {
  id: number;
  action: string;
  comment: string | null;
  created_at: string;
  full_name: string;
  login: string;
}

export async function taskEvents(taskId: number): Promise<TaskEventRow[]> {
  return await all<TaskEventRow>(
    `SELECT e.id, e.action, e.comment, e.created_at, u.full_name, u.login
     FROM task_events e JOIN users u ON u.id = e.user_id
     WHERE e.task_id = ? ORDER BY e.id`,
    taskId,
  );
}

/* ------------------------------------------------------------------ */
/* People                                                             */
/* ------------------------------------------------------------------ */

export async function userById(id: number): Promise<User | undefined> {
  return await get<User>("SELECT * FROM users WHERE id = ?", id);
}

export async function userByLogin(login: string): Promise<User | undefined> {
  return await get<User>(
    "SELECT * FROM users WHERE lower(login) = lower(?) AND is_active = 1",
    login,
  );
}

export async function rais(): Promise<User | undefined> {
  return await get<User>("SELECT * FROM users WHERE role = 'RAIS' LIMIT 1");
}

export async function subordinates(userId: number): Promise<User[]> {
  return await all<User>(
    "SELECT * FROM users WHERE manager_id = ? AND is_active = 1 ORDER BY full_name",
    userId,
  );
}

/** Who this user is allowed to hand an assignment to. */
export async function assignableUsers(user: User): Promise<User[]> {
  if (user.role === "RAIS") {
    return await all<User>(
      "SELECT * FROM users WHERE id != ? AND is_active = 1 ORDER BY role, full_name",
      user.id,
    );
  }
  if (user.role === "ISHCHI") {
    // Staff may only report upward, never assign.
    return [];
  }
  // Heads: own staff, plus peer departments and association / project leads.
  return await all<User>(
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
export async function directory(excludeId: number): Promise<DirectoryEntry[]> {
  return await all<DirectoryEntry>(
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

/**
 * Unread across both rails: one-to-one messages still marked unread, plus group
 * messages past this member's high-water mark. Four placeholders, every one of
 * them the same user id.
 */
const UNREAD_TOTAL = `
  (SELECT COUNT(*) FROM messages
     WHERE to_user_id = ? AND group_id IS NULL AND read_at IS NULL)
  + (SELECT COUNT(*) FROM messages m
       JOIN group_members gm ON gm.group_id = m.group_id AND gm.user_id = ?
      WHERE m.from_user_id != ?
        AND m.id > COALESCE((SELECT r.last_read_id FROM group_reads r
                              WHERE r.group_id = m.group_id AND r.user_id = ?), 0))
`;

export async function counters(userId: number): Promise<Counters> {
  const day = todayUtc();
  const row = await get<Counters>(
    `SELECT
       (SELECT COUNT(*) FROM tasks WHERE to_user_id = ? AND status = 'YANGI') AS incoming,
       (SELECT COUNT(*) FROM tasks WHERE to_user_id = ? AND status IN ('QABUL_QILINDI','BAJARILMOQDA','QAYTARILDI')) AS inWork,
       (SELECT COUNT(*) FROM tasks WHERE COALESCE(reviewer_user_id, from_user_id) = ?
          AND status = 'TEKSHIRUVDA') AS onReview,
       -- Counted over stages, not tasks: the moment a chain moves on, its
       -- first participant stops being \`to_user_id\` and the work they
       -- actually finished would vanish from their own tally.
       (SELECT COUNT(*) FROM task_stages s WHERE s.to_user_id = ? AND s.status = 'BAJARILDI') AS completed,
       (SELECT COUNT(*) FROM tasks WHERE to_user_id = ? AND deadline IS NOT NULL AND deadline < ?
          AND status NOT IN ('BAJARILDI','RAD_ETILDI')) AS overdue,
       (SELECT COUNT(*) FROM tasks WHERE from_user_id = ?) AS sent,
       (SELECT COUNT(*) FROM tasks WHERE from_user_id = ? AND status NOT IN ('BAJARILDI','RAD_ETILDI')) AS sentActive,
       (SELECT COUNT(*) FROM tasks WHERE from_user_id = ? AND status = 'BAJARILDI') AS sentDone,
       (SELECT COUNT(*) FROM tasks WHERE from_user_id = ? AND deadline IS NOT NULL AND deadline < ?
          AND status NOT IN ('BAJARILDI','RAD_ETILDI')) AS sentOverdue,
       ${UNREAD_TOTAL} AS unread,
       (SELECT COUNT(*) FROM users WHERE manager_id = ? AND is_active = 1) AS team`,
    userId,
    userId,
    userId,
    userId,
    userId,
    day, // overdue
    userId,
    userId,
    userId,
    userId,
    day, // sentOverdue
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

export async function pulse(user: User): Promise<Pulse> {
  const userId = user.id;
  const mine = (await get<Omit<Pulse, "orgRev">>(
    `SELECT
       (SELECT COALESCE(MAX(e.id), 0) FROM task_events e
          JOIN tasks t ON t.id = e.task_id
          WHERE t.to_user_id = ? OR t.from_user_id = ?) AS taskRev,
       (SELECT COALESCE(MAX(id), 0) FROM messages
          WHERE to_user_id = ? OR from_user_id = ?
             OR group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)) AS msgRev,
       (SELECT COUNT(*) FROM tasks WHERE to_user_id = ? AND status = 'YANGI') AS incoming,
       (SELECT COUNT(*) FROM tasks WHERE to_user_id = ? AND status IN ('QABUL_QILINDI','BAJARILMOQDA','QAYTARILDI')) AS inWork,
       (SELECT COUNT(*) FROM tasks WHERE from_user_id = ? AND status = 'TEKSHIRUVDA') AS onReview,
       ${UNREAD_TOTAL} AS unread`,
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
    userId,
  ))!;

  const orgRev = isManager(user.role)
    ? Number(
        (
          await get<{ rev: number }>(
            "SELECT COALESCE(MAX(id), 0) AS rev FROM task_events",
          )
        )?.rev ?? 0,
      )
    : 0;

  return { ...mine, orgRev };
}

export async function recentTasks(
  userId: number,
  limit = 6,
): Promise<TaskRow[]> {
  return await all<TaskRow>(
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

export async function orgTotals(): Promise<OrgTotals> {
  return (await get<OrgTotals>(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE is_active = 1) AS users,
       (SELECT COUNT(*) FROM uyushmalar) AS uyushmalar,
       (SELECT COUNT(*) FROM loyihalar) AS loyihalar,
       (SELECT COUNT(*) FROM tasks) AS tasks,
       (SELECT COUNT(*) FROM tasks WHERE status = 'BAJARILDI') AS done,
       (SELECT COUNT(*) FROM tasks WHERE deadline IS NOT NULL AND deadline < ?
          AND status NOT IN ('BAJARILDI','RAD_ETILDI')) AS overdue,
       (SELECT COALESCE(SUM(members_count),0) FROM uyushmalar) AS members,
       (SELECT COALESCE(SUM(budget),0) FROM loyihalar) AS budget`,
    todayUtc(),
  ))!;
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

export async function departmentStats(): Promise<DeptStat[]> {
  return await all<DeptStat>(
    `SELECT d.department,
            h.full_name AS head_name,
            h.login AS head_login,
            (SELECT COUNT(*) FROM users s WHERE s.department = d.department AND s.role = 'ISHCHI' AND s.is_active = 1) AS staff,
            (SELECT COUNT(*) FROM tasks t WHERE t.to_department = d.department) AS total,
            (SELECT COUNT(*) FROM tasks t WHERE t.to_department = d.department AND t.status = 'BAJARILDI') AS done,
            (SELECT COUNT(*) FROM tasks t WHERE t.to_department = d.department AND t.status IN ('YANGI','QABUL_QILINDI','BAJARILMOQDA','TEKSHIRUVDA')) AS active,
            (SELECT COUNT(*) FROM tasks t WHERE t.to_department = d.department AND t.deadline < ? AND t.status NOT IN ('BAJARILDI','RAD_ETILDI')) AS overdue
     FROM (SELECT 'GR' AS department UNION ALL SELECT 'FR' UNION ALL SELECT 'BR'
           UNION ALL SELECT 'PR' UNION ALL SELECT 'AI_LAB') d
     LEFT JOIN users h ON h.department = d.department AND h.role IN ('BOLIM_RAHBARI','AI_LAB')`,
    todayUtc(),
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

export async function uyushmaStats(): Promise<UyushmaStat[]> {
  return await all<UyushmaStat>(
    `SELECT u.id, u.name, u.short_name, u.sector, u.region, u.members_count,
            h.full_name AS head_name, h.login AS head_login,
            (SELECT COUNT(*) FROM loyihalar l WHERE l.uyushma_id = u.id) AS projects,
            (SELECT COALESCE(SUM(l.budget),0) FROM loyihalar l WHERE l.uyushma_id = u.id) AS budget,
            (SELECT COUNT(*) FROM tasks t WHERE t.uyushma_id = u.id) AS tasks_total,
            (SELECT COUNT(*) FROM tasks t WHERE t.uyushma_id = u.id AND t.status = 'BAJARILDI') AS tasks_done,
            (SELECT COUNT(*) FROM tasks t WHERE t.uyushma_id = u.id AND t.status IN ('YANGI','QABUL_QILINDI','BAJARILMOQDA','TEKSHIRUVDA')) AS tasks_active,
            (SELECT COUNT(*) FROM tasks t WHERE t.uyushma_id = u.id AND t.deadline < ? AND t.status NOT IN ('BAJARILDI','RAD_ETILDI')) AS tasks_overdue
     FROM uyushmalar u
     LEFT JOIN users h ON h.id = u.head_user_id
     ORDER BY u.name`,
    todayUtc(),
  );
}

export interface StatusSlice {
  status: string;
  count: number;
}

export async function taskStatusBreakdown(
  uyushmaId?: number,
): Promise<StatusSlice[]> {
  return uyushmaId
    ? await all<StatusSlice>(
        "SELECT status, COUNT(*) AS count FROM tasks WHERE uyushma_id = ? GROUP BY status",
        uyushmaId,
      )
    : await all<StatusSlice>(
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

export async function projects(): Promise<ProjectRow[]> {
  return await all<ProjectRow>(
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

export async function teamStats(managerId: number): Promise<TeamMemberStat[]> {
  return await all<TeamMemberStat>(
    // All four read \`task_stages\`, which the backfill filled with one row per
    // existing task — so on a plain assignment every number is what it was.
    // On a chain they stop crediting the whole job to whoever happens to hold
    // it last, and the deadline still comes from the task: there is one
    // deadline for the whole chain, deliberately, so "overdue" keeps one
    // meaning.
    `SELECT u.*,
            (SELECT COUNT(*) FROM task_stages s WHERE s.to_user_id = u.id) AS total,
            (SELECT COUNT(*) FROM task_stages s WHERE s.to_user_id = u.id AND s.status = 'BAJARILDI') AS done,
            (SELECT COUNT(*) FROM task_stages s WHERE s.to_user_id = u.id
               AND s.status IN ('YANGI','QABUL_QILINDI','BAJARILMOQDA','TEKSHIRUVDA')) AS active,
            (SELECT COUNT(*) FROM task_stages s JOIN tasks t ON t.id = s.task_id
              WHERE s.to_user_id = u.id AND t.deadline < ?
                AND s.status NOT IN ('KUTMOQDA','BAJARILDI','RAD_ETILDI')) AS overdue
     FROM users u WHERE u.manager_id = ? AND u.is_active = 1
     ORDER BY u.full_name`,
    todayUtc(),
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
  /** Lets the rail label an attachment ("Photo", "Voice message") when the
   *  caption is empty, instead of showing a blank preview line. */
  last_kind: MessageKind;
  last_at: string;
  last_from: number;
  unread: number;
}

export async function conversations(userId: number): Promise<Conversation[]> {
  return await all<Conversation>(
    `WITH partners AS (
       SELECT CASE WHEN from_user_id = ? THEN to_user_id ELSE from_user_id END AS pid,
              MAX(id) AS last_id
       FROM messages
       WHERE group_id IS NULL AND (from_user_id = ? OR to_user_id = ?)
       GROUP BY pid
     )
     SELECT u.id, u.login, u.full_name, u.role, u.department, u.position,
            m.body AS last_body, m.kind AS last_kind,
            m.created_at AS last_at, m.from_user_id AS last_from,
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
  kind: MessageKind;
  file_name: string | null;
  file_size: number | null;
  file_mime: string | null;
  duration: number | null;
  created_at: string;
  read_at: string | null;
}

/**
 * Everything a thread row needs, minus `file_key`: the storage path is a
 * server-side detail, and these rows are handed straight to a Client Component.
 * Attachments are addressed by message id through `/api/files/[id]` instead.
 */
const MESSAGE_COLUMNS = `id, from_user_id, to_user_id, body, kind,
                         file_name, file_size, file_mime, duration,
                         created_at, read_at`;

/** The ids of everyone this user has exchanged messages with. */
export async function conversationPartnerIds(
  userId: number,
): Promise<number[]> {
  const rows = await all<{ id: number }>(
    `SELECT DISTINCT
       CASE WHEN from_user_id = ? THEN to_user_id ELSE from_user_id END AS id
     FROM messages
     WHERE group_id IS NULL AND (from_user_id = ? OR to_user_id = ?)`,
    userId,
    userId,
    userId,
  );
  return rows.map((row) => row.id);
}

/* ------------------------------------------------------------------ */
/* Group chats                                                        */
/* ------------------------------------------------------------------ */

export interface GroupSummary {
  id: number;
  title: string;
  created_by: number;
  members: number;
  last_body: string;
  last_kind: MessageKind;
  last_at: string | null;
  last_from_name: string | null;
  unread: number;
}

/**
 * The groups this user belongs to, most recently active first. A group with no
 * messages yet still appears — it was just created and someone has to speak
 * first — which is why the message join is a LEFT one.
 */
export async function userGroups(userId: number): Promise<GroupSummary[]> {
  return await all<GroupSummary>(
    `SELECT g.id, g.title, g.created_by,
            (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS members,
            COALESCE(last.body, '')     AS last_body,
            COALESCE(last.kind, 'text') AS last_kind,
            last.created_at             AS last_at,
            lu.full_name                AS last_from_name,
            (SELECT COUNT(*) FROM messages x
              WHERE x.group_id = g.id
                AND x.from_user_id != ?
                AND x.id > COALESCE((SELECT r.last_read_id FROM group_reads r
                                      WHERE r.group_id = g.id AND r.user_id = ?), 0)
            ) AS unread
       FROM chat_groups g
       JOIN group_members me ON me.group_id = g.id AND me.user_id = ?
       LEFT JOIN messages last
              ON last.id = (SELECT MAX(id) FROM messages WHERE group_id = g.id)
       LEFT JOIN users lu ON lu.id = last.from_user_id
      ORDER BY COALESCE(last.id, 0) DESC, g.id DESC`,
    userId,
    userId,
    userId,
  );
}

export interface GroupRow {
  id: number;
  title: string;
  created_by: number;
  created_at: string;
}

export async function groupById(
  groupId: number,
): Promise<GroupRow | undefined> {
  return await get<GroupRow>("SELECT * FROM chat_groups WHERE id = ?", groupId);
}

export async function isGroupMember(
  groupId: number,
  userId: number,
): Promise<boolean> {
  return (
    (await get<{ user_id: number }>(
      "SELECT user_id FROM group_members WHERE group_id = ? AND user_id = ?",
      groupId,
      userId,
    )) !== undefined
  );
}

export interface GroupMember {
  id: number;
  login: string;
  full_name: string;
  role: Role;
}

export async function groupMembers(groupId: number): Promise<GroupMember[]> {
  return await all<GroupMember>(
    `SELECT u.id, u.login, u.full_name, u.role
       FROM group_members m JOIN users u ON u.id = m.user_id
      WHERE m.group_id = ?
      ORDER BY u.full_name`,
    groupId,
  );
}

/** A group message carries its author's name: everyone sees several senders. */
export interface GroupMessage extends Omit<ChatMessage, "to_user_id" | "read_at"> {
  from_name: string;
  from_login: string;
}

export async function groupThread(
  groupId: number,
  opts: { before?: number; limit?: number } = {},
): Promise<GroupMessage[]> {
  const limit = opts.limit ?? THREAD_PAGE;
  const params: number[] = [groupId];
  if (opts.before) params.push(opts.before);
  params.push(limit);

  const rows = await all<GroupMessage>(
    `SELECT m.id, m.from_user_id, u.full_name AS from_name, u.login AS from_login,
            m.body, m.kind, m.file_name, m.file_size, m.file_mime, m.duration,
            m.created_at
       FROM messages m JOIN users u ON u.id = m.from_user_id
      WHERE m.group_id = ?
        ${opts.before ? "AND m.id < ?" : ""}
      ORDER BY m.id DESC
      LIMIT ?`,
    ...params,
  );
  return rows.reverse();
}

/**
 * Moves this member's high-water mark to the newest message in the group.
 * Returns true when it actually moved, so the caller only publishes then.
 */
export async function markGroupRead(
  groupId: number,
  userId: number,
): Promise<boolean> {
  const newest = Number(
    (
      await get<{ id: number }>(
        "SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE group_id = ?",
        groupId,
      )
    )?.id ?? 0,
  );
  const current = Number(
    (
      await get<{ last_read_id: number }>(
        "SELECT last_read_id FROM group_reads WHERE group_id = ? AND user_id = ?",
        groupId,
        userId,
      )
    )?.last_read_id ?? 0,
  );
  if (newest <= current) return false;

  await run(
    `INSERT INTO group_reads (group_id, user_id, last_read_id) VALUES (?,?,?)
     ON CONFLICT(group_id, user_id) DO UPDATE SET last_read_id = excluded.last_read_id`,
    groupId,
    userId,
    newest,
  );
  return true;
}

export interface Attachment {
  id: number;
  from_user_id: number;
  to_user_id: number | null;
  group_id: number | null;
  kind: MessageKind;
  file_name: string | null;
  file_mime: string | null;
  file_key: string | null;
}

/**
 * The stored blob behind one message, for `/api/files/[id]`. Includes both
 * participant ids so the route can verify the reader belongs to the thread —
 * an attachment is exactly as private as the conversation it was sent in.
 */
export async function attachment(
  messageId: number,
): Promise<Attachment | undefined> {
  return await get<Attachment>(
    `SELECT id, from_user_id, to_user_id, group_id, kind, file_name, file_mime, file_key
     FROM messages WHERE id = ?`,
    messageId,
  );
}

/** How many messages one thread page holds. */
export const THREAD_PAGE = 50;

/**
 * A page of a conversation, newest `THREAD_PAGE` by default, returned in
 * ascending (display) order. Pass `before` — the oldest id currently shown — to
 * fetch the previous page, so long threads load lazily instead of all at once.
 */
export async function thread(
  userId: number,
  otherId: number,
  opts: { before?: number; limit?: number } = {},
): Promise<ChatMessage[]> {
  const limit = opts.limit ?? THREAD_PAGE;
  const params: (number | null)[] = [userId, otherId, otherId, userId];
  if (opts.before) params.push(opts.before);
  params.push(limit);

  // Take the newest `limit` (optionally older than `before`), then flip to
  // ascending so the caller renders oldest → newest.
  const rows = await all<ChatMessage>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages
     WHERE ((from_user_id = ? AND to_user_id = ?) OR (from_user_id = ? AND to_user_id = ?))
       ${opts.before ? "AND id < ?" : ""}
     ORDER BY id DESC
     LIMIT ?`,
    ...params,
  );
  return rows.reverse();
}
