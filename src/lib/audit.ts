import { all, get, run } from "./pg";

/**
 * The audit trail of TZ 4.4 — writing to it and reading it back.
 *
 * Creates, changes and deletes are written by the database itself (the
 * `audit_row` trigger in the schema), so no route can forget one. What only
 * the application knows is written here: a question put to the global AI
 * view (4.2, "every global query is logged: who, when, what was asked").
 */

export type AuditAction = "INSERT" | "UPDATE" | "DELETE" | "AI_GLOBAL";

/** Records one global AI question. Never throws: a log that cannot be
 *  written must not cost the person his answer — it is reported instead. */
export async function logGlobalQuestion(userId: number, question: string): Promise<void> {
  try {
    await run(
      `INSERT INTO audit_log (actor_id, action, entity, detail)
       VALUES (?, 'AI_GLOBAL', 'assistant', ?::jsonb)`,
      userId,
      JSON.stringify({ question: question.slice(0, 2000) }),
    );
  } catch (error) {
    console.error("[audit] could not record a global AI question:", error);
  }
}

export interface AuditRow {
  id: number;
  at: string;
  actor_id: number | null;
  actor_name: string | null;
  action: AuditAction;
  entity: string;
  entity_id: string | null;
  detail: Record<string, unknown> | null;
}

export const AUDIT_PAGE = 50;

/** One page of the journal, newest first, optionally narrowed. */
export async function auditPage(filter: {
  entity?: string | null;
  actorId?: number | null;
  action?: AuditAction | null;
  before?: number | null;
}): Promise<{ rows: AuditRow[]; more: boolean }> {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.entity) {
    where.push("a.entity = ?");
    params.push(filter.entity);
  }
  if (filter.actorId) {
    where.push("a.actor_id = ?");
    params.push(filter.actorId);
  }
  if (filter.action) {
    where.push("a.action = ?");
    params.push(filter.action);
  }
  if (filter.before) {
    where.push("a.id < ?");
    params.push(filter.before);
  }
  const rows = await all<AuditRow>(
    `SELECT a.id, a.at, a.actor_id, u.full_name AS actor_name, a.action,
            a.entity, a.entity_id, a.detail
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.actor_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY a.id DESC
      LIMIT ${AUDIT_PAGE + 1}`,
    ...params,
  );
  return { rows: rows.slice(0, AUDIT_PAGE), more: rows.length > AUDIT_PAGE };
}

/** The tables the journal has entries for, for the filter. */
export async function auditEntities(): Promise<string[]> {
  return (
    await all<{ entity: string }>(
      "SELECT DISTINCT entity FROM audit_log ORDER BY entity",
    )
  ).map((row) => row.entity);
}

/** How many entries the journal holds. */
export async function auditCount(): Promise<number> {
  return Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log"))?.n ?? 0);
}
