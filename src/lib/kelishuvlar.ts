import { all, get, type Tx } from "./pg";
import { obligationsOf, today, type AgreementRow } from "./crm";
import {
  KELISHUV_STATUSES,
  viewKelishuv,
  type KelishuvShape,
  type KelishuvStatus,
  type KelishuvView,
} from "./kelishuv-fields";

export {
  CURRENCIES,
  KELISHUV_KINDS,
  KELISHUV_REQUIRED,
  KELISHUV_STATUSES,
  kelishuvCode,
  missingKelishuv,
  viewKelishuv,
  type Currency,
  type KelishuvField,
  type KelishuvKind,
  type KelishuvShape,
  type KelishuvStatus,
  type KelishuvView,
} from "./kelishuv-fields";

/**
 * Agreements as documents, block 1.2 of the rebuild TZ.
 *
 * An agreement here is the thing the commitments in `agreements` come from: a
 * memorandum, a letter of intent, a contract or a word given across a table,
 * between named parties, with a sum and a term. Its obligations are the
 * commitments that carry its id, and they keep everything a commitment
 * already had — the deadline board, the reminder, the task.
 */

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

export interface KelishuvDetail extends KelishuvShape {
  id: number;
  title: string;
  status: string;
  view: KelishuvView;
  project_code: string | null;
  project_name: string | null;
  meeting_id: number | null;
  meeting_title: string | null;
  amount: number | null;
  currency: string | null;
  signed_on: string | null;
  valid_until: string | null;
  responsible_name: string | null;
  file_key: string | null;
  file_name: string | null;
  file_size: number | null;
  created_by: number | null;
  creator_name: string | null;
  created_at: string;
  updated_at: string | null;
  parties: { id: number; name: string }[];
  obligations: AgreementRow[];
}

const SHAPE_COUNTS = `
  (SELECT COUNT(*) FROM kelishuv_parties kp WHERE kp.kelishuv_id = k.id) AS party_count,
  (SELECT COUNT(*) FROM agreements a WHERE a.kelishuv_id = k.id) AS obligation_count`;

/** One agreement with its parties and every obligation under it. */
export async function kelishuvById(
  id: number,
): Promise<KelishuvDetail | undefined> {
  const row = await get<Omit<KelishuvDetail, "view" | "parties" | "obligations">>(
    `SELECT k.*, l.code AS project_code, l.name AS project_name,
            m.title AS meeting_title, r.full_name AS responsible_name,
            c.full_name AS creator_name,
            ${SHAPE_COUNTS}
       FROM kelishuvlar k
       LEFT JOIN loyihalar l ON l.id = k.loyiha_id
       LEFT JOIN meetings m ON m.id = k.meeting_id
       LEFT JOIN users r ON r.id = k.responsible_id
       LEFT JOIN users c ON c.id = k.created_by
      WHERE k.id = ?`,
    id,
  );
  if (!row) return undefined;

  const [parties, obligations] = await Promise.all([
    all<{ id: number; name: string }>(
      `SELECT p.id, p.name
         FROM kelishuv_parties kp JOIN partners p ON p.id = kp.company_id
        WHERE kp.kelishuv_id = ?
        ORDER BY p.name`,
      id,
    ),
    obligationsOf(id),
  ]);

  return {
    ...row,
    view: viewKelishuv(row.status, row.valid_until, today()),
    parties,
    obligations,
  };
}

export interface KelishuvListRow extends KelishuvShape {
  id: number;
  title: string;
  status: string;
  view: KelishuvView;
  amount: number | null;
  currency: string | null;
  signed_on: string | null;
  valid_until: string | null;
  happened: string;
  parties: string | null;
  open_obligations: number;
}

export const KELISHUV_PAGE = 30;

/** The filter tabs the TZ asks for, "All" first and the default. */
export type KelishuvFilter = "ALL" | KelishuvStatus;

function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, "\\$&")}%`;
}

/**
 * Agreements, newest first, narrowed by status and by a search.
 *
 * The TZ's complaint about the old page was that it showed only what was
 * still open, when a fulfilled or cancelled agreement is exactly what gets
 * looked up later — so "All" is the default and closed ones are in it. The
 * counts for every tab come back with the page so the tabs can say how many
 * each holds without a second round trip per tab.
 */
export async function searchKelishuvlar(filter: {
  status?: KelishuvFilter;
  query?: string;
  companyId?: number | null;
  projectId?: number | null;
  page?: number;
}): Promise<{
  rows: KelishuvListRow[];
  total: number;
  counts: Record<KelishuvFilter, number>;
}> {
  const where: string[] = [];
  const params: (string | number)[] = [];

  const query = filter.query?.trim();
  if (query) {
    const like = likePattern(query);
    where.push(
      `(k.title ILIKE ? OR k.content ILIKE ?
        OR EXISTS (SELECT 1 FROM kelishuv_parties kp JOIN partners p ON p.id = kp.company_id
                    WHERE kp.kelishuv_id = k.id AND p.name ILIKE ?))`,
    );
    params.push(like, like, like);
  }
  if (filter.companyId) {
    where.push(
      "EXISTS (SELECT 1 FROM kelishuv_parties kp WHERE kp.kelishuv_id = k.id AND kp.company_id = ?)",
    );
    params.push(filter.companyId);
  }
  if (filter.projectId) {
    where.push("k.loyiha_id = ?");
    params.push(filter.projectId);
  }

  // The tab counts obey the search but not the tab itself: each tab says how
  // many it would show for what was typed.
  const base = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const grouped = await all<{ status: string; n: number }>(
    `SELECT k.status, COUNT(*) AS n FROM kelishuvlar k ${base} GROUP BY k.status`,
    ...params,
  );
  const counts = { ALL: 0 } as Record<KelishuvFilter, number>;
  for (const status of KELISHUV_STATUSES) counts[status] = 0;
  for (const row of grouped) {
    const n = Number(row.n);
    counts.ALL += n;
    if ((KELISHUV_STATUSES as readonly string[]).includes(row.status))
      counts[row.status as KelishuvStatus] += n;
  }

  const status = filter.status && filter.status !== "ALL" ? filter.status : null;
  if (status) {
    where.push("k.status = ?");
    params.push(status);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const page = Math.max(0, filter.page ?? 0);
  const rows = await all<Omit<KelishuvListRow, "view">>(
    `SELECT k.id, k.title, k.kind, k.status, k.content, k.loyiha_id,
            k.responsible_id, k.amount, k.currency, k.signed_on, k.valid_until,
            COALESCE(k.signed_on, k.created_at) AS happened,
            (SELECT string_agg(p.name, ', ' ORDER BY p.name)
               FROM kelishuv_parties kp JOIN partners p ON p.id = kp.company_id
              WHERE kp.kelishuv_id = k.id) AS parties,
            (SELECT COUNT(*) FROM agreements a
              WHERE a.kelishuv_id = k.id AND a.status IN ('NEW','IN_PROGRESS')) AS open_obligations,
            ${SHAPE_COUNTS}
       FROM kelishuvlar k
     ${clause}
      ORDER BY happened DESC, k.id DESC
      LIMIT ? OFFSET ?`,
    ...params,
    KELISHUV_PAGE,
    page * KELISHUV_PAGE,
  );

  const day = today();
  return {
    rows: rows.map((row) => ({
      ...row,
      view: viewKelishuv(row.status, row.valid_until, day),
    })),
    total: status ? counts[status] : counts.ALL,
    counts,
  };
}

/** The agreements drawn up from one meeting, for that meeting's page. */
export async function kelishuvlarOfMeeting(
  meetingId: number,
): Promise<{ id: number; title: string; kind: string | null; status: string; valid_until: string | null }[]> {
  return await all(
    `SELECT id, title, kind, status, valid_until FROM kelishuvlar
      WHERE meeting_id = ? ORDER BY id`,
    meetingId,
  );
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Makes the party list say exactly `wanted`, touching only what changed.
 *
 * Each removed party is copied into `archive` by the database; replacing the
 * whole list on every save would archive the unchanged ones too and bury the
 * one removal that happened.
 */
export async function setParties(
  q: Tx,
  kelishuvId: number,
  wanted: number[],
): Promise<void> {
  const ids = [...new Set(wanted)];
  if (ids.length === 0) {
    await q.run("DELETE FROM kelishuv_parties WHERE kelishuv_id = ?", kelishuvId);
    return;
  }
  await q.run(
    `DELETE FROM kelishuv_parties
      WHERE kelishuv_id = ? AND company_id NOT IN (${ids.map(() => "?").join(",")})`,
    kelishuvId,
    ...ids,
  );
  for (const id of ids) {
    await q.run(
      `INSERT INTO kelishuv_parties (kelishuv_id, company_id) VALUES (?, ?)
       ON CONFLICT DO NOTHING`,
      kelishuvId,
      id,
    );
  }
}
