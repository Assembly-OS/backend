import { all, get, type Param } from "../pg";
import type { User } from "../types";
import { visibleSourcesSql } from "./access";
import { embeddingProvider, vectorLiteral } from "./embeddings";
import { excerpt, finalScore, fuseRanks, searchTerms, tsQuery, type SourceKind } from "./text";
import { evidenceHref, hrefFor, type FactRow, type SourceRow } from "./types";

/**
 * Finding passages and facts for a question — permission-filtered, hybrid.
 *
 * Two searches run when both can: words (Postgres full text, prefix-matched
 * per `searchTerms`) and meaning (cosine over stored embeddings, when a
 * provider is configured). Their rankings are fused, then weighted by how
 * far the source kind is trusted and how recent the record is. Every query
 * carries `visibleSourcesSql(user)`, so a passage this person may not read
 * is never in a candidate list, let alone an answer.
 */

export interface SearchFilter {
  kinds?: SourceKind[];
  projectId?: number | null;
  uyushmaId?: number | null;
  authorId?: number | null;
  /** YYYY-MM-DD, inclusive, against the day the thing happened. */
  from?: string | null;
  to?: string | null;
  limit?: number;
}

export interface Hit {
  chunk_id: number;
  source_id: number;
  kind: SourceKind;
  ref_id: number;
  title: string;
  section: string | null;
  body: string;
  excerpt: string;
  position: number;
  chunk_count: number;
  occurred_at: string | null;
  indexed_at: string | null;
  author_name: string | null;
  project_code: string | null;
  reliability: number;
  status: string;
  score: number;
  href: string;
  evidence_href: string;
}

type Candidate = Omit<Hit, "excerpt" | "score" | "href" | "evidence_href"> & {
  rank: number;
  other_login: string | null;
} & Pick<SourceRow, "project_id" | "thread_id" | "group_id" | "company_id" | "from_user_id">;

const HIT_SELECT = `
  SELECT c.id AS chunk_id, c.source_id, s.kind, s.ref_id, s.title, c.section, c.body, c.position,
         s.chunk_count, s.occurred_at, s.indexed_at, s.reliability, s.status,
         s.project_id, s.thread_id, s.group_id, s.company_id, s.from_user_id,
         u.full_name AS author_name, l.code AS project_code,
         CASE WHEN s.kind = 'message' AND s.group_id IS NULL THEN
           (SELECT o.login FROM users o
             WHERE o.id = CASE WHEN s.from_user_id = ? THEN s.to_user_id ELSE s.from_user_id END)
         END AS other_login`;

const HIT_FROM = `
    FROM knowledge_chunks c
    JOIN knowledge_sources s ON s.id = c.source_id AND s.version = c.version
    LEFT JOIN users u ON u.id = s.author_id
    LEFT JOIN loyihalar l ON l.id = s.project_id`;

function filterSql(filter: SearchFilter, alias = "s"): { sql: string[]; params: Param[] } {
  const sql: string[] = [`${alias}.status IN ('READY', 'PARTIAL')`];
  const params: Param[] = [];
  if (filter.kinds?.length) {
    sql.push(`${alias}.kind IN (${filter.kinds.map(() => "?").join(",")})`);
    params.push(...filter.kinds);
  }
  if (filter.projectId) {
    sql.push(`${alias}.project_id = ?`);
    params.push(filter.projectId);
  }
  if (filter.uyushmaId) {
    sql.push(`${alias}.uyushma_id = ?`);
    params.push(filter.uyushmaId);
  }
  if (filter.authorId) {
    sql.push(`${alias}.author_id = ?`);
    params.push(filter.authorId);
  }
  if (filter.from) {
    sql.push(`COALESCE(${alias}.occurred_at, ${alias}.created_at) >= ?`);
    params.push(filter.from);
  }
  if (filter.to) {
    sql.push(`COALESCE(${alias}.occurred_at, ${alias}.created_at) <= ?`);
    params.push(`${filter.to} 23:59:59`);
  }
  return { sql, params };
}

function toHit(candidate: Candidate, terms: string[], score: number): Hit {
  const { rank: _rank, other_login, ...rest } = candidate;
  void _rank;
  return {
    ...rest,
    excerpt: excerpt(candidate.body, terms),
    score,
    href: hrefFor({ ...candidate, other_login }),
    evidence_href: evidenceHref(candidate.source_id),
  };
}

/** Candidates per search before fusion. */
const POOL = 40;

export async function searchKnowledge(
  user: User,
  query: string,
  filter: SearchFilter = {},
): Promise<Hit[]> {
  const terms = searchTerms(query);
  const visible = visibleSourcesSql(user, "s");
  const extra = filterSql(filter);
  const where = [visible.sql, ...extra.sql];
  const baseParams: Param[] = [user.id, ...visible.params, ...extra.params];
  const limit = Math.min(filter.limit ?? 8, 20);

  const lists: { id: number; score: number }[][] = [];
  const byId = new Map<number, Candidate>();

  if (terms.length > 0) {
    const rows = await all<Candidate>(
      `${HIT_SELECT}, ts_rank_cd(c.search, q) AS rank
       ${HIT_FROM}
       CROSS JOIN to_tsquery('simple', ?) q
       WHERE c.search @@ q AND ${where.join(" AND ")}
       ORDER BY rank DESC, s.occurred_at DESC NULLS LAST, c.id DESC
       LIMIT ${POOL}`,
      baseParams[0],
      tsQuery(terms),
      ...baseParams.slice(1),
    );
    lists.push(rows.map((row) => ({ id: row.chunk_id, score: Number(row.rank) })));
    for (const row of rows) byId.set(row.chunk_id, row);
  }

  const provider = embeddingProvider();
  if (provider && query.trim()) {
    try {
      const [vector] = await provider.embed([query], "query");
      const rows = await all<Candidate>(
        `${HIT_SELECT}, knowledge_cosine(c.embedding, ?::real[]) AS rank
         ${HIT_FROM}
         WHERE c.embedding IS NOT NULL AND ${where.join(" AND ")}
         ORDER BY rank DESC NULLS LAST
         LIMIT ${POOL}`,
        baseParams[0],
        vectorLiteral(vector),
        ...baseParams.slice(1),
      );
      // Below this the match is noise, whatever its rank.
      const kept = rows.filter((row) => Number(row.rank) >= 0.25);
      lists.push(kept.map((row) => ({ id: row.chunk_id, score: Number(row.rank) })));
      for (const row of kept) if (!byId.has(row.chunk_id)) byId.set(row.chunk_id, row);
    } catch (error) {
      // Word search still answers; the meaning search is a bonus that failed.
      console.error("[knowledge] embedding search failed:", error);
    }
  }

  const fused = fuseRanks(lists);
  const now = new Date();
  const scored = [...fused.entries()]
    .map(([id, rank]) => {
      const candidate = byId.get(id)!;
      return { candidate, score: finalScore(rank, candidate.reliability, candidate.occurred_at, now) };
    })
    .sort((a, b) => b.score - a.score);

  // At most three passages from one source: a long document must not fill
  // the whole list and crowd out the task that says what happened next.
  const perSource = new Map<number, number>();
  const hits: Hit[] = [];
  for (const { candidate, score } of scored) {
    const seen = perSource.get(candidate.source_id) ?? 0;
    if (seen >= 3) continue;
    perSource.set(candidate.source_id, seen + 1);
    hits.push(toHit(candidate, terms, score));
    if (hits.length >= limit) break;
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/* Reading a source                                                    */
/* ------------------------------------------------------------------ */

export interface SourceText {
  source: SourceRow & { author_name: string | null; project_code: string | null; href: string };
  chunks: { id: number; position: number; section: string | null; body: string }[];
  nextPosition: number | null;
}

/**
 * A source's passages in order, from a position, as many as fit — and only
 * when this person may read the source. `nextPosition` is how a reader
 * continues rather than being handed a cut-off text.
 */
export async function readSource(
  user: User,
  sourceId: number,
  options: { from?: number; maxChars?: number; maxChunks?: number } = {},
): Promise<SourceText | null> {
  const visible = visibleSourcesSql(user, "s");
  const source = await get<SourceRow & { author_name: string | null; project_code: string | null; other_login: string | null }>(
    `SELECT s.*, u.full_name AS author_name, l.code AS project_code,
            CASE WHEN s.kind = 'message' AND s.group_id IS NULL THEN
              (SELECT o.login FROM users o
                WHERE o.id = CASE WHEN s.from_user_id = ? THEN s.to_user_id ELSE s.from_user_id END)
            END AS other_login
       FROM knowledge_sources s
       LEFT JOIN users u ON u.id = s.author_id
       LEFT JOIN loyihalar l ON l.id = s.project_id
      WHERE s.id = ? AND s.status <> 'DELETED' AND ${visible.sql}`,
    user.id,
    sourceId,
    ...visible.params,
  );
  if (!source) return null;

  const from = Math.max(1, options.from ?? 1);
  const rows = await all<{ id: number; position: number; section: string | null; body: string }>(
    `SELECT id, position, section, body FROM knowledge_chunks
      WHERE source_id = ? AND version = ? AND position >= ?
      ORDER BY position LIMIT ?`,
    source.id,
    source.version,
    from,
    options.maxChunks ?? 60,
  );
  const maxChars = options.maxChars ?? 30_000;
  const chunks: typeof rows = [];
  let used = 0;
  for (const row of rows) {
    if (chunks.length > 0 && used + row.body.length > maxChars) break;
    chunks.push(row);
    used += row.body.length;
  }
  const last = chunks.at(-1)?.position ?? from - 1;
  const { other_login, ...rest } = source;
  return {
    source: { ...rest, href: hrefFor({ ...source, other_login }) },
    chunks,
    nextPosition: last < source.chunk_count ? last + 1 : null,
  };
}

/* ------------------------------------------------------------------ */
/* Facts                                                               */
/* ------------------------------------------------------------------ */

export interface FactFilter {
  query?: string | null;
  kinds?: FactRow["kind"][];
  projectId?: number | null;
  whoUserId?: number | null;
  who?: string | null;
  dueBefore?: string | null;
  dueAfter?: string | null;
  from?: string | null;
  to?: string | null;
  /** Only facts linked to an open task, or only unlinked ones. */
  limit?: number;
}

export interface FactHit extends FactRow {
  source_kind: SourceKind;
  source_title: string;
  occurred_at: string | null;
  reliability: number;
  who_name: string | null;
  task_code: string | null;
  task_status: string | null;
  href: string;
  evidence_href: string;
}

export async function findFacts(user: User, filter: FactFilter = {}): Promise<FactHit[]> {
  const visible = visibleSourcesSql(user, "s");
  const extra = filterSql({ projectId: filter.projectId, from: filter.from, to: filter.to });
  const where = [visible.sql, ...extra.sql, "f.status <> 'rejected'"];
  const params: Param[] = [user.id, ...visible.params, ...extra.params];

  if (filter.kinds?.length) {
    where.push(`f.kind IN (${filter.kinds.map(() => "?").join(",")})`);
    params.push(...filter.kinds);
  }
  if (filter.whoUserId) {
    where.push("f.who_user_id = ?");
    params.push(filter.whoUserId);
  }
  if (filter.who) {
    where.push("(f.who ILIKE ? OR w.full_name ILIKE ?)");
    params.push(`%${filter.who.slice(0, 80)}%`, `%${filter.who.slice(0, 80)}%`);
  }
  if (filter.dueBefore) {
    where.push("f.due_on IS NOT NULL AND f.due_on <= ?");
    params.push(filter.dueBefore);
  }
  if (filter.dueAfter) {
    where.push("f.due_on IS NOT NULL AND f.due_on >= ?");
    params.push(filter.dueAfter);
  }
  const terms = filter.query ? searchTerms(filter.query) : [];
  let order = "f.due_on NULLS LAST, s.occurred_at DESC NULLS LAST, f.id DESC";
  if (terms.length > 0) {
    where.push("f.search @@ to_tsquery('simple', ?)");
    params.push(tsQuery(terms));
    order = `ts_rank_cd(f.search, to_tsquery('simple', ?)) DESC, ${order}`;
  }

  type FactLine = Omit<FactHit, "href" | "evidence_href"> & {
    other_login: string | null;
    project_id: number | null;
    thread_id: number | null;
    group_id: number | null;
    company_id: number | null;
    from_user_id: number | null;
    ref_id: number;
  };
  const rows = await all<FactLine>(
    `SELECT f.*, s.kind AS source_kind, s.title AS source_title, s.occurred_at, s.reliability,
            s.ref_id, s.project_id, s.thread_id, s.group_id, s.company_id, s.from_user_id,
            w.full_name AS who_name, t.code AS task_code, t.status AS task_status,
            CASE WHEN s.kind = 'message' AND s.group_id IS NULL THEN
              (SELECT o.login FROM users o
                WHERE o.id = CASE WHEN s.from_user_id = ? THEN s.to_user_id ELSE s.from_user_id END)
            END AS other_login
       FROM knowledge_facts f
       JOIN knowledge_sources s ON s.id = f.source_id AND s.version = f.version
       LEFT JOIN users w ON w.id = f.who_user_id
       LEFT JOIN tasks t ON t.id = f.task_id
      WHERE ${where.join(" AND ")}
      ORDER BY ${order}
      LIMIT ?`,
    ...params,
    ...(terms.length > 0 ? [tsQuery(terms)] : []),
    Math.min(filter.limit ?? 20, 50),
  );
  return rows.map((row) => {
    const { other_login, project_id, thread_id, group_id, company_id, from_user_id, ref_id, ...rest } = row;
    return {
      ...rest,
      href: hrefFor({
        kind: row.source_kind,
        ref_id,
        project_id,
        thread_id,
        group_id,
        company_id,
        from_user_id,
        other_login,
      }),
      evidence_href: evidenceHref(row.source_id),
    };
  });
}

/* ------------------------------------------------------------------ */
/* What is known about something                                      */
/* ------------------------------------------------------------------ */

export interface SourceSummary {
  source_id: number;
  kind: SourceKind;
  ref_id: number;
  title: string;
  occurred_at: string | null;
  author_name: string | null;
  project_code: string | null;
  status: string;
  chunk_count: number;
  href: string;
  evidence_href: string;
}

/**
 * The records the memory holds about a project, a person, a company or a
 * period — the table of contents for "what do we know about X".
 */
export async function sourcesAbout(
  user: User,
  about: {
    projectId?: number | null;
    uyushmaId?: number | null;
    personId?: number | null;
    companyId?: number | null;
    taskId?: number | null;
    kinds?: SourceKind[];
    from?: string | null;
    to?: string | null;
    limit?: number;
  },
): Promise<SourceSummary[]> {
  const visible = visibleSourcesSql(user, "s");
  const extra = filterSql({ kinds: about.kinds, from: about.from, to: about.to });
  const where = [visible.sql, ...extra.sql];
  const params: Param[] = [user.id, ...visible.params, ...extra.params];
  if (about.projectId) {
    where.push(
      "(s.project_id = ? OR EXISTS (SELECT 1 FROM knowledge_links k WHERE k.source_id = s.id AND k.to_kind = 'project' AND k.to_id = ?))",
    );
    params.push(about.projectId, about.projectId);
  }
  if (about.uyushmaId) {
    where.push("s.uyushma_id = ?");
    params.push(about.uyushmaId);
  }
  if (about.personId) {
    where.push(
      "(s.author_id = ? OR s.to_user_id = ? OR EXISTS (SELECT 1 FROM knowledge_links k WHERE k.source_id = s.id AND k.to_kind = 'person' AND k.to_id = ?))",
    );
    params.push(about.personId, about.personId, about.personId);
  }
  if (about.companyId) {
    where.push(
      "(s.company_id = ? OR EXISTS (SELECT 1 FROM knowledge_links k WHERE k.source_id = s.id AND k.to_kind = 'company' AND k.to_id = ?))",
    );
    params.push(about.companyId, about.companyId);
  }
  if (about.taskId) {
    where.push(
      "(s.task_id = ? OR EXISTS (SELECT 1 FROM knowledge_links k WHERE k.source_id = s.id AND k.to_kind = 'task' AND k.to_id = ?))",
    );
    params.push(about.taskId, about.taskId);
  }
  interface SummaryRow {
    source_id: number;
    kind: SourceKind;
    ref_id: number;
    title: string;
    occurred_at: string | null;
    author_name: string | null;
    project_code: string | null;
    status: string;
    chunk_count: number;
    project_id: number | null;
    thread_id: number | null;
    group_id: number | null;
    company_id: number | null;
    from_user_id: number | null;
    other_login: string | null;
  }
  const rows = await all<SummaryRow>(
    `SELECT s.id AS source_id, s.kind, s.ref_id, s.title, s.occurred_at, s.status, s.chunk_count,
            s.project_id, s.thread_id, s.group_id, s.company_id, s.from_user_id,
            u.full_name AS author_name, l.code AS project_code,
            CASE WHEN s.kind = 'message' AND s.group_id IS NULL THEN
              (SELECT o.login FROM users o
                WHERE o.id = CASE WHEN s.from_user_id = ? THEN s.to_user_id ELSE s.from_user_id END)
            END AS other_login
       FROM knowledge_sources s
       LEFT JOIN users u ON u.id = s.author_id
       LEFT JOIN loyihalar l ON l.id = s.project_id
      WHERE ${where.join(" AND ")}
      ORDER BY COALESCE(s.occurred_at, s.created_at) DESC, s.id DESC
      LIMIT ?`,
    ...params,
    Math.min(about.limit ?? 30, 60),
  );
  return rows.map((row) => ({
    source_id: row.source_id,
    kind: row.kind,
    ref_id: row.ref_id,
    title: row.title,
    occurred_at: row.occurred_at,
    author_name: row.author_name,
    project_code: row.project_code,
    status: row.status,
    chunk_count: row.chunk_count,
    href: hrefFor(row),
    evidence_href: evidenceHref(row.source_id),
  }));
}
