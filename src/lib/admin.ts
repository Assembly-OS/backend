import { all, get } from "./pg";
import type { MessageKind, Role } from "./types";

/**
 * Staff administration queries, used by the standalone panel under /admin.
 * Access is decided by `lib/admin-auth.ts` — a separate account, not a role in
 * the org chart — so nothing here inspects the caller.
 */

/** A login we are willing to store: lowercase, dotted, no surprises in a URL. */
export const LOGIN_PATTERN = /^[a-z0-9]([a-z0-9._-]{1,30}[a-z0-9])$/;

export const MIN_PASSWORD = 8;

export interface StaffRow {
  id: number;
  login: string;
  full_name: string;
  role: Role;
  department: string | null;
  position: string | null;
  phone: string | null;
  email: string | null;
  is_active: number;
  last_seen: string | null;
  created_at: string;
  manager_id: number | null;
  manager_name: string | null;
  /** Assignments that name this person, in either direction. */
  tasks: number;
}

/** Everyone on the books — active first, then alphabetical. */
export async function staff(): Promise<StaffRow[]> {
  return await all<StaffRow>(
    `SELECT u.id, u.login, u.full_name, u.role, u.department, u.position,
            u.phone, u.email, u.is_active, u.last_seen, u.created_at,
            u.manager_id, m.full_name AS manager_name,
            (SELECT COUNT(*) FROM tasks t
              WHERE t.to_user_id = u.id OR t.from_user_id = u.id) AS tasks
       FROM users u
       LEFT JOIN users m ON m.id = u.manager_id
      ORDER BY u.is_active DESC, u.full_name`,
  );
}

/** Candidates for the "reports to" field: anyone still active. */
export async function managerOptions(): Promise<
  { id: number; label: string }[]
> {
  const rows = await all<{ id: number; full_name: string; login: string }>(
    "SELECT id, full_name, login FROM users WHERE is_active = 1 ORDER BY full_name",
  );
  return rows.map((row) => ({
    id: row.id,
    label: `${row.full_name} (@${row.login})`,
  }));
}

/** True when the login is already taken (comparison is case-insensitive). */
export async function loginTaken(login: string): Promise<boolean> {
  return (
    (await get<{ id: number }>(
      "SELECT id FROM users WHERE lower(login) = lower(?)",
      login,
    )) !== undefined
  );
}

/* ------------------------------------------------------------------ */
/* Chat oversight                                                     */
/* ------------------------------------------------------------------ */

export interface ConversationSummary {
  a: number;
  b: number;
  a_name: string;
  a_login: string;
  b_name: string;
  b_login: string;
  total: number;
  attachments: number;
  last_body: string;
  last_kind: MessageKind;
  last_at: string;
  last_id: number;
}

/**
 * Every conversation in the Assembly, newest activity first. A thread is
 * identified by its unordered pair of participants, so `min`/`max` fold the
 * two directions of the same conversation into one row.
 */
export async function allConversations(): Promise<ConversationSummary[]> {
  return await all<ConversationSummary>(
    `WITH pairs AS (
       SELECT LEAST(from_user_id, to_user_id) AS a,
              GREATEST(from_user_id, to_user_id) AS b,
              COUNT(*) AS total,
              MAX(id) AS last_id
         FROM messages
        GROUP BY a, b
     )
     SELECT p.a, p.b, p.total, p.last_id,
            ua.full_name AS a_name, ua.login AS a_login,
            ub.full_name AS b_name, ub.login AS b_login,
            m.body AS last_body, m.kind AS last_kind, m.created_at AS last_at,
            (SELECT COUNT(*) FROM messages x
              WHERE ((x.from_user_id = p.a AND x.to_user_id = p.b)
                  OR (x.from_user_id = p.b AND x.to_user_id = p.a))
                AND x.kind != 'text') AS attachments
       FROM pairs p
       JOIN users ua ON ua.id = p.a
       JOIN users ub ON ub.id = p.b
       JOIN messages m ON m.id = p.last_id
      ORDER BY p.last_id DESC`,
  );
}

export interface GroupOverview {
  id: number;
  title: string;
  members: number;
  member_names: string;
  total: number;
  attachments: number;
  last_body: string;
  last_kind: MessageKind;
  last_at: string | null;
  last_id: number;
}

/** Every group conversation in the Assembly, most recently active first. */
export async function allGroups(): Promise<GroupOverview[]> {
  return await all<GroupOverview>(
    `SELECT g.id, g.title,
            (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS members,
            (SELECT string_agg(u.full_name, ', ')
               FROM group_members m JOIN users u ON u.id = m.user_id
              WHERE m.group_id = g.id) AS member_names,
            (SELECT COUNT(*) FROM messages x WHERE x.group_id = g.id) AS total,
            (SELECT COUNT(*) FROM messages x
              WHERE x.group_id = g.id AND x.kind != 'text') AS attachments,
            COALESCE(last.body, '')     AS last_body,
            COALESCE(last.kind, 'text') AS last_kind,
            last.created_at             AS last_at,
            COALESCE(last.id, 0)        AS last_id
       FROM chat_groups g
       LEFT JOIN messages last
              ON last.id = (SELECT MAX(id) FROM messages WHERE group_id = g.id)
      ORDER BY COALESCE(last.id, 0) DESC, g.id DESC`,
  );
}

/** One group's full history, oldest first — the same shape as a DM audit. */
export async function groupConversation(
  groupId: number,
  limit = 300,
): Promise<AuditMessage[]> {
  const rows = await all<AuditMessage>(
    `SELECT m.id, m.from_user_id, u.full_name AS from_name, u.login AS from_login,
            m.body, m.kind, m.file_name, m.file_size, m.duration,
            m.created_at, m.read_at
       FROM messages m JOIN users u ON u.id = m.from_user_id
      WHERE m.group_id = ?
      ORDER BY m.id DESC
      LIMIT ?`,
    groupId,
    limit,
  );
  return rows.reverse();
}

export interface AuditMessage {
  id: number;
  from_user_id: number;
  from_name: string;
  from_login: string;
  body: string;
  kind: MessageKind;
  file_name: string | null;
  file_size: number | null;
  duration: number | null;
  created_at: string;
  read_at: string | null;
}

/** One full conversation, oldest first. Capped so a long thread stays loadable. */
export async function conversation(
  aId: number,
  bId: number,
  limit = 300,
): Promise<AuditMessage[]> {
  const rows = await all<AuditMessage>(
    `SELECT m.id, m.from_user_id, u.full_name AS from_name, u.login AS from_login,
            m.body, m.kind, m.file_name, m.file_size, m.duration,
            m.created_at, m.read_at
       FROM messages m
       JOIN users u ON u.id = m.from_user_id
      WHERE (m.from_user_id = ? AND m.to_user_id = ?)
         OR (m.from_user_id = ? AND m.to_user_id = ?)
      ORDER BY m.id DESC
      LIMIT ?`,
    aId,
    bId,
    bId,
    aId,
    limit,
  );
  return rows.reverse();
}

/** Storage key behind one message, so deleting it can take the blob too. */
export async function messageFileKey(
  messageId: number,
): Promise<string | null> {
  return (
    (
      await get<{ file_key: string | null }>(
        "SELECT file_key FROM messages WHERE id = ?",
        messageId,
      )
    )?.file_key ?? null
  );
}

/**
 * How many active chairmen remain. Demoting or deactivating the last one would
 * leave the Assembly with nobody able to hand out work, so the routes refuse.
 */
export async function activeRaisCount(): Promise<number> {
  return Number(
    (
      await get<{ c: number }>(
        "SELECT COUNT(*) AS c FROM users WHERE role = 'RAIS' AND is_active = 1",
      )
    )?.c ?? 0,
  );
}
