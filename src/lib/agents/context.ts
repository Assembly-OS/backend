import { all } from "@/lib/db";
import type { DataScope } from "./registry";

/**
 * CONTEXT RETRIEVAL — step 2 of the TZ §10.1 pattern.
 *
 * The orchestrator asks for exactly the scopes an agent declares, and this
 * module is the only place that reads business data on an agent's behalf. An
 * agent never gets a database handle, so "no permission → no answer" (TZ §9.2)
 * is a property of the wiring rather than a rule the model is asked to follow.
 *
 * Every reader is bounded. An agent that could pull the whole table would make
 * its token ceiling unenforceable, and a summary built from 40 rows is the one
 * a human can actually check.
 */

const LIMIT = 200;

export interface TaskRow {
  id: number;
  code: string;
  title: string;
  status: string;
  priority: string;
  deadline: string | null;
  created_at: string;
  from_name: string;
  to_id: number;
  to_name: string;
  /** Days past the deadline; negative means still in hand. Null if undated. */
  overdue_days: number | null;
}

export interface StaffRow {
  id: number;
  login: string;
  full_name: string;
  role: string;
  department: string | null;
  last_seen: string | null;
  open_tasks: number;
  overdue_tasks: number;
}

export interface EventRow {
  id: number;
  action: string;
  created_at: string;
  code: string;
  actor: string;
}

export interface ProjectRow {
  id: number;
  code: string;
  name: string;
  status: string;
  progress: number;
  deadline: string | null;
  owner_id: number | null;
}

export interface AssociationRow {
  id: number;
  name: string;
  sector: string;
  members_count: number;
  head_user_id: number | null;
}

export interface MessageStat {
  total: number;
  attachments: number;
  last_at: string | null;
}

export interface AgentContext {
  tasks?: TaskRow[];
  task_events?: EventRow[];
  staff?: StaffRow[];
  projects?: ProjectRow[];
  associations?: AssociationRow[];
  /** Volume only — an agent is never handed the text of private messages. */
  messages?: MessageStat;
  /** Total rows handed over, recorded on the run for the audit log. */
  rows: number;
}

export function loadContext(scopes: DataScope[]): AgentContext {
  const context: AgentContext = { rows: 0 };

  if (scopes.includes("tasks")) {
    context.tasks = all<TaskRow>(
      `SELECT t.id, t.code, t.title, t.status, t.priority, t.deadline, t.created_at,
              uf.full_name AS from_name, t.to_user_id AS to_id, ut.full_name AS to_name,
              CASE WHEN t.deadline IS NULL THEN NULL
                   ELSE CAST(julianday('now') - julianday(t.deadline) AS INTEGER) END AS overdue_days
         FROM tasks t
         JOIN users uf ON uf.id = t.from_user_id
         JOIN users ut ON ut.id = t.to_user_id
        ORDER BY t.id DESC LIMIT ?`,
      LIMIT,
    );
    context.rows += context.tasks.length;
  }

  if (scopes.includes("task_events")) {
    context.task_events = all<EventRow>(
      `SELECT e.id, e.action, e.created_at, t.code, u.full_name AS actor
         FROM task_events e
         JOIN tasks t ON t.id = e.task_id
         JOIN users u ON u.id = e.user_id
        ORDER BY e.id DESC LIMIT ?`,
      LIMIT,
    );
    context.rows += context.task_events.length;
  }

  if (scopes.includes("staff")) {
    context.staff = all<StaffRow>(
      `SELECT u.id, u.login, u.full_name, u.role, u.department, u.last_seen,
              (SELECT COUNT(*) FROM tasks t WHERE t.to_user_id = u.id
                 AND t.status NOT IN ('BAJARILDI','RAD_ETILDI')) AS open_tasks,
              (SELECT COUNT(*) FROM tasks t WHERE t.to_user_id = u.id
                 AND t.deadline IS NOT NULL AND t.deadline < date('now')
                 AND t.status NOT IN ('BAJARILDI','RAD_ETILDI')) AS overdue_tasks
         FROM users u WHERE u.is_active = 1
        ORDER BY u.full_name LIMIT ?`,
      LIMIT,
    );
    context.rows += context.staff.length;
  }

  if (scopes.includes("projects")) {
    context.projects = all<ProjectRow>(
      `SELECT id, code, name, status, progress, deadline, owner_id
         FROM loyihalar ORDER BY id LIMIT ?`,
      LIMIT,
    );
    context.rows += context.projects.length;
  }

  if (scopes.includes("associations")) {
    context.associations = all<AssociationRow>(
      `SELECT id, name, sector, members_count, head_user_id
         FROM uyushmalar ORDER BY id LIMIT ?`,
      LIMIT,
    );
    context.rows += context.associations.length;
  }

  if (scopes.includes("messages")) {
    // Counts, never content. The Risk agent needs to know that traffic exists
    // and roughly when — it has no business reading what colleagues wrote.
    const stat = all<MessageStat>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN kind != 'text' THEN 1 ELSE 0 END) AS attachments,
              MAX(created_at) AS last_at
         FROM messages`,
    )[0];
    context.messages = stat ?? { total: 0, attachments: 0, last_at: null };
    context.rows += 1;
  }

  return context;
}
