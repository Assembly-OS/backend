import { all, get, now, run } from "../pg";
import type { User } from "../types";
import { visibleSourcesSql } from "./access";
import { enqueueJob, kick, retryJobs } from "./jobs";
import { RELIABILITY, type SourceKind } from "./text";
import { hrefFor, type SourceRow, type SourceStatus, type SourceView } from "./types";

/**
 * The register of what the memory has read: one row per original record.
 *
 * `remember(kind, id)` is the one call every write route makes after it has
 * saved something — a task, a message, a journal entry. It costs one insert
 * and never throws into the route: a memory that cannot be queued is logged,
 * and the record the person saved is saved regardless. `forget` is its pair
 * for a delete.
 */

/** Creates the row for a record, or touches the existing one. */
export async function upsertSource(
  kind: SourceKind,
  refId: number,
): Promise<{ id: number; version: number; status: SourceStatus }> {
  const row = await get<{ id: number; version: number; status: SourceStatus }>(
    `INSERT INTO knowledge_sources (kind, ref_id, reliability, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (kind, ref_id) DO UPDATE SET updated_at = EXCLUDED.updated_at
     RETURNING id, version, status`,
    kind,
    refId,
    RELIABILITY[kind],
    now(),
    now(),
  );
  if (!row) throw new Error("knowledge source was not written");
  return row;
}

/**
 * Queues a record to be read (again). Idempotent: an open job for the same
 * record is left alone, and a record whose content has not changed is
 * recognised by its fingerprint when the job runs and costs nothing more.
 */
export async function remember(
  kind: SourceKind,
  refId: number,
  options: { delaySeconds?: number } = {},
): Promise<number | null> {
  try {
    const source = await upsertSource(kind, refId);
    // A record that was deleted and then recreated under the same id is a
    // new record; let it be read.
    if (source.status === "DELETED")
      await run(
        "UPDATE knowledge_sources SET status = 'PENDING', reason = NULL WHERE id = ?",
        source.id,
      );
    await enqueueJob(source.id, "index", options.delaySeconds ?? 0);
    kick();
    return source.id;
  } catch (error) {
    console.error(`[knowledge] could not queue ${kind} ${refId}:`, error);
    return null;
  }
}

/**
 * A record is gone: its passages and facts go with it at once, so nothing
 * deleted keeps answering questions. The source row stays, marked DELETED,
 * as the record that something was once here.
 */
export async function forget(kind: SourceKind, refId: number): Promise<void> {
  try {
    const source = await get<{ id: number }>(
      "SELECT id FROM knowledge_sources WHERE kind = ? AND ref_id = ?",
      kind,
      refId,
    );
    if (!source) return;
    await retire(source.id, "GONE");
  } catch (error) {
    console.error(`[knowledge] could not forget ${kind} ${refId}:`, error);
  }
}

/** A whole journal thread is gone: every entry's source goes with it. */
export async function forgetThread(threadId: number): Promise<void> {
  try {
    const rows = await all<{ id: number }>(
      "SELECT id FROM knowledge_sources WHERE kind = 'thread_entry' AND thread_id = ? AND status <> 'DELETED'",
      threadId,
    );
    for (const row of rows) await retire(row.id, "GONE");
  } catch (error) {
    console.error(`[knowledge] could not forget thread ${threadId}:`, error);
  }
}

/** Marks a source DELETED and removes everything derived from it. */
export async function retire(sourceId: number, reason: "GONE"): Promise<void> {
  await run("DELETE FROM knowledge_chunks WHERE source_id = ?", sourceId);
  await run("DELETE FROM knowledge_facts WHERE source_id = ?", sourceId);
  await run("DELETE FROM knowledge_links WHERE source_id = ?", sourceId);
  await run(
    "DELETE FROM knowledge_jobs WHERE source_id = ? AND status IN ('QUEUED', 'FAILED')",
    sourceId,
  );
  await run(
    `UPDATE knowledge_sources SET status = 'DELETED', reason = ?, chunk_count = 0,
            text_chars = 0, updated_at = ? WHERE id = ?`,
    reason,
    now(),
    sourceId,
  );
}

/** Queues a source to be read again, clearing a failure. */
export async function retrySource(sourceId: number): Promise<void> {
  await run(
    `UPDATE knowledge_sources SET status = CASE WHEN status = 'DELETED' THEN status ELSE 'PENDING' END,
            reason = NULL, updated_at = ? WHERE id = ?`,
    now(),
    sourceId,
  );
  await retryJobs(sourceId);
  kick();
}

export async function sourceById(id: number): Promise<SourceRow | undefined> {
  return await get<SourceRow>("SELECT * FROM knowledge_sources WHERE id = ?", id);
}

export async function sourceByRef(
  kind: SourceKind,
  refId: number,
): Promise<SourceRow | undefined> {
  return await get<SourceRow>(
    "SELECT * FROM knowledge_sources WHERE kind = ? AND ref_id = ?",
    kind,
    refId,
  );
}

/* ------------------------------------------------------------------ */
/* Listing                                                             */
/* ------------------------------------------------------------------ */

export interface SourceFilter {
  kinds?: SourceKind[];
  projectId?: number | null;
  authorId?: number | null;
  status?: SourceStatus | "OPEN" | null;
  /** YYYY-MM-DD, inclusive, against the day the thing happened. */
  from?: string | null;
  to?: string | null;
  query?: string | null;
  limit?: number;
  before?: number | null;
}

export const SOURCE_PAGE = 40;

const VIEW_SELECT = `
  SELECT s.*, u.full_name AS author_name, l.code AS project_code, l.name AS project_name,
         (SELECT j.error FROM knowledge_jobs j WHERE j.source_id = s.id AND j.error IS NOT NULL
           ORDER BY j.id DESC LIMIT 1) AS last_error,
         CASE WHEN s.kind = 'message' AND s.group_id IS NULL THEN
           (SELECT o.login FROM users o
             WHERE o.id = CASE WHEN s.from_user_id = ? THEN s.to_user_id ELSE s.from_user_id END)
         END AS other_login
    FROM knowledge_sources s
    LEFT JOIN users u ON u.id = s.author_id
    LEFT JOIN loyihalar l ON l.id = s.project_id`;

function withHref(row: SourceView & { other_login?: string | null }): SourceView {
  const { other_login, ...rest } = row;
  return { ...rest, href: hrefFor({ ...row, other_login }) };
}

/** The sources this person may read, newest first, narrowed by the filter. */
export async function listSources(
  user: User,
  filter: SourceFilter = {},
): Promise<{ rows: SourceView[]; more: boolean }> {
  const visible = visibleSourcesSql(user, "s");
  const where: string[] = [visible.sql, "s.status <> 'DELETED'"];
  const params: (string | number)[] = [user.id, ...(visible.params as (string | number)[])];

  if (filter.kinds?.length) {
    where.push(`s.kind IN (${filter.kinds.map(() => "?").join(",")})`);
    params.push(...filter.kinds);
  }
  if (filter.projectId) {
    where.push("s.project_id = ?");
    params.push(filter.projectId);
  }
  if (filter.authorId) {
    where.push("s.author_id = ?");
    params.push(filter.authorId);
  }
  if (filter.status === "OPEN") where.push("s.status IN ('PENDING', 'PROCESSING', 'FAILED')");
  else if (filter.status) {
    where.push("s.status = ?");
    params.push(filter.status);
  }
  if (filter.from) {
    where.push("COALESCE(s.occurred_at, s.created_at) >= ?");
    params.push(filter.from);
  }
  if (filter.to) {
    where.push("COALESCE(s.occurred_at, s.created_at) <= ?");
    params.push(`${filter.to} 23:59:59`);
  }
  if (filter.query?.trim()) {
    where.push("s.title ILIKE ?");
    params.push(`%${filter.query.trim().slice(0, 100)}%`);
  }
  if (filter.before) {
    where.push("s.id < ?");
    params.push(filter.before);
  }

  const limit = filter.limit ?? SOURCE_PAGE;
  const rows = await all<SourceView & { other_login?: string | null }>(
    `${VIEW_SELECT} WHERE ${where.join(" AND ")}
      ORDER BY s.id DESC LIMIT ${limit + 1}`,
    ...params,
  );
  return { rows: rows.slice(0, limit).map(withHref), more: rows.length > limit };
}

/** One source, if this person may read it. */
export async function viewSource(user: User, id: number): Promise<SourceView | undefined> {
  const visible = visibleSourcesSql(user, "s");
  const row = await get<SourceView & { other_login?: string | null }>(
    `${VIEW_SELECT} WHERE s.id = ? AND ${visible.sql}`,
    user.id,
    id,
    ...visible.params,
  );
  return row ? withHref(row) : undefined;
}

export interface MemoryStats {
  total: number;
  ready: number;
  pending: number;
  failed: number;
  by_kind: { kind: SourceKind; count: number }[];
  last_indexed_at: string | null;
}

/** The whole memory's state, for the status strip. Counts only — no content. */
export async function memoryStats(): Promise<MemoryStats> {
  const totals = await get<{ total: number; ready: number; pending: number; failed: number; last: string | null }>(
    `SELECT COUNT(*) FILTER (WHERE status <> 'DELETED') AS total,
            COUNT(*) FILTER (WHERE status IN ('READY', 'PARTIAL')) AS ready,
            COUNT(*) FILTER (WHERE status IN ('PENDING', 'PROCESSING')) AS pending,
            COUNT(*) FILTER (WHERE status = 'FAILED') AS failed,
            MAX(indexed_at) AS last
       FROM knowledge_sources`,
  );
  const byKind = await all<{ kind: SourceKind; count: number }>(
    `SELECT kind, COUNT(*) AS count FROM knowledge_sources
      WHERE status IN ('READY', 'PARTIAL') GROUP BY kind ORDER BY count DESC`,
  );
  return {
    total: Number(totals?.total ?? 0),
    ready: Number(totals?.ready ?? 0),
    pending: Number(totals?.pending ?? 0),
    failed: Number(totals?.failed ?? 0),
    by_kind: byKind.map((row) => ({ kind: row.kind, count: Number(row.count) })),
    last_indexed_at: totals?.last ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Backfill                                                            */
/* ------------------------------------------------------------------ */

/** Every table the memory reads from, with the id column to enumerate. */
const BACKFILL: { kind: SourceKind; sql: string }[] = [
  { kind: "task", sql: "SELECT id FROM tasks" },
  { kind: "meeting", sql: "SELECT id FROM meetings" },
  { kind: "thread_entry", sql: "SELECT id FROM thread_entries" },
  {
    kind: "message",
    // Attachments and voice notes always; text only when there is some.
    sql: "SELECT id FROM messages WHERE kind <> 'text' OR length(body) >= 12",
  },
  { kind: "project_document", sql: "SELECT id FROM project_documents" },
  { kind: "library", sql: "SELECT id FROM knowledge_documents" },
  { kind: "kelishuv", sql: "SELECT id FROM kelishuvlar" },
  { kind: "agreement", sql: "SELECT id FROM agreements" },
  { kind: "project", sql: "SELECT id FROM loyihalar" },
  { kind: "uyushma", sql: "SELECT id FROM uyushmalar" },
  { kind: "partner", sql: "SELECT id FROM partners" },
];

/**
 * Queues every existing record once. Safe to run again: records already
 * read are recognised by fingerprint and skipped by the worker. Returns how
 * many jobs were actually queued.
 */
export async function enqueueBackfill(kinds?: SourceKind[]): Promise<number> {
  let queued = 0;
  for (const entry of BACKFILL) {
    if (kinds && !kinds.includes(entry.kind)) continue;
    const ids = await all<{ id: number }>(entry.sql);
    for (const { id } of ids) {
      const source = await upsertSource(entry.kind, id);
      if (source.status === "DELETED") continue;
      if (await enqueueJob(source.id, "index")) queued++;
    }
  }
  if (queued > 0) kick();
  return queued;
}
