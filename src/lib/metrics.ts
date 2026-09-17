/**
 * One definition per figure, for every page that shows it.
 *
 * The audit behind the rebuild TZ found the same indicator carrying four
 * different values: total assignments read 67 on the dashboard, 64 on
 * statistics, 58 on the assignment form; "done" read 19, 15 and 0. None of
 * that was a broken query. Each page had written its own `COUNT(*)` with its
 * own idea of which statuses belong in which bucket, and the four ideas
 * disagreed. A manager who cannot trust the number stops opening the page,
 * which is the failure the TZ opens with.
 *
 * So the vocabulary lives here and the queries import it. The fix is not
 * clever: it is that `done` is one string in one file, and every page that
 * counts it counts the same thing by construction.
 *
 * ## What the four buckets mean
 *
 * There are seven task statuses and every one of them belongs to exactly one
 * bucket — that is the property the page totals depend on, because a status
 * that falls through every bucket is work that exists and appears nowhere:
 *
 * | Bucket   | Statuses                                                  |
 * |----------|-----------------------------------------------------------|
 * | open     | YANGI, QABUL_QILINDI, BAJARILMOQDA, TEKSHIRUVDA, QAYTARILDI |
 * | done     | BAJARILDI                                                 |
 * | rejected | RAD_ETILDI                                                |
 *
 * `QAYTARILDI` is the status that used to fall through. The department,
 * association and team queries all defined "active" as the first four and
 * "done" as `BAJARILDI`, so an assignment sent back for rework was counted in
 * neither — present in the total, missing from both columns beside it. It
 * belongs in `open`: work returned for rework is work somebody still owes.
 *
 * ## Placeholders
 *
 * `overdueSql()` carries exactly one `?`, for today's date. `lib/pg` numbers
 * placeholders by position as it rewrites `?` into `$n`, so a fragment that
 * hides a placeholder inside itself shifts every argument after it. One
 * placeholder, always in the same spot, is the contract these fragments keep.
 */

import type { TaskStatus } from "./types";

/* ------------------------------------------------------------------ */
/* The buckets                                                         */
/* ------------------------------------------------------------------ */

/** Work that is still somebody's to move — including work sent back. */
export const OPEN_STATUSES: TaskStatus[] = [
  "YANGI",
  "QABUL_QILINDI",
  "BAJARILMOQDA",
  "TEKSHIRUVDA",
  "QAYTARILDI",
];

/** Finished and approved. The only status that counts as a result. */
export const DONE_STATUSES: TaskStatus[] = ["BAJARILDI"];

/** Refused outright, never carried out. */
export const REJECTED_STATUSES: TaskStatus[] = ["RAD_ETILDI"];

/**
 * Statuses that end an assignment's life.
 *
 * Used by every "overdue" test: a deadline that passed after the work was
 * finished or refused is not a missed deadline, it is history.
 */
export const CLOSED_STATUSES: TaskStatus[] = [
  ...DONE_STATUSES,
  ...REJECTED_STATUSES,
];

/* ------------------------------------------------------------------ */
/* SQL fragments                                                       */
/* ------------------------------------------------------------------ */

/**
 * `'A','B','C'` — a status list ready to drop inside `IN (…)`.
 *
 * Inlined rather than parameterised on purpose. These are compile-time
 * constants from a closed union, never user input, and passing them as
 * parameters would add a variable number of placeholders to fragments whose
 * whole contract is that their placeholder count never moves.
 */
export function statusList(statuses: TaskStatus[]): string {
  return statuses.map((s) => `'${s}'`).join(",");
}

/** Shorthand for the common case. */
const list = statusList;

/** Qualifies a column with a table alias when the query uses one. */
function col(alias: string, column: string): string {
  return alias ? `${alias}.${column}` : column;
}

/** Still owed by somebody. Pass the alias the query gave the table. */
export function openSql(alias = ""): string {
  return `${col(alias, "status")} IN (${list(OPEN_STATUSES)})`;
}

/** Finished and approved. */
export function doneSql(alias = ""): string {
  return `${col(alias, "status")} = '${DONE_STATUSES[0]}'`;
}

/** Refused. */
export function rejectedSql(alias = ""): string {
  return `${col(alias, "status")} IN (${list(REJECTED_STATUSES)})`;
}

/**
 * Past its deadline and still owed. **Consumes one `?` — today's date.**
 *
 * The `IS NOT NULL` guard is not redundant. Postgres evaluates `NULL < date`
 * to NULL, which a WHERE clause discards, so the guard changes no row today —
 * it is there because the TZ introduces open-ended assignments that carry no
 * deadline by design, and the day one of those reaches a query written without
 * the guard, the silent NULL becomes a silent wrong answer. Saying it out loud
 * costs nothing and survives that change.
 */
export function overdueSql(alias = ""): string {
  return (
    `${col(alias, "deadline")} IS NOT NULL AND ${col(alias, "deadline")} < ?` +
    ` AND ${col(alias, "status")} NOT IN (${list(CLOSED_STATUSES)})`
  );
}

/* ------------------------------------------------------------------ */
/* Scope — what a number is counting over                              */
/* ------------------------------------------------------------------ */

/**
 * The reach of a figure, shown beside it.
 *
 * The audit's sharpest example: the dashboard shows "Overdue 0" and it is
 * true — for the person reading it. The statistics page shows 2, also true,
 * for the whole Assembly. Neither said which, so the chairman read "0" as
 * "nothing in the Assembly is late". A figure without its reach is not a
 * smaller truth, it is a different claim.
 */
export type MetricScope =
  | "personal"
  | "team"
  | "department"
  | "uyushma"
  | "org"
  | "week";

/** One figure the interface shows, and what it is counting over. */
export interface MetricMeta {
  /** Dictionary key for the formula shown when the figure is opened. */
  readonly key: string;
  readonly scope: MetricScope;
}

/**
 * Every figure in the interface, with its reach.
 *
 * Keyed by the field name the API already returns, so a page renders the chip
 * by looking up the key it is already holding — no call site changes shape.
 * The formula text itself lives in the four dictionaries under
 * `metricFormula.<key>`, because it is read by people in four languages.
 */
export const METRICS: Record<string, MetricMeta> = {
  /* Dashboard — counters(), all counted over one person */
  incoming: { key: "incoming", scope: "personal" },
  inWork: { key: "inWork", scope: "personal" },
  onReview: { key: "onReview", scope: "personal" },
  completed: { key: "completed", scope: "personal" },
  overdue: { key: "overdue", scope: "personal" },
  sent: { key: "sent", scope: "personal" },
  sentActive: { key: "sentActive", scope: "personal" },
  sentDone: { key: "sentDone", scope: "personal" },
  sentOverdue: { key: "sentOverdue", scope: "personal" },
  unread: { key: "unread", scope: "personal" },
  team: { key: "team", scope: "team" },

  /* Statistics — the whole Assembly */
  orgUsers: { key: "orgUsers", scope: "org" },
  orgUyushmalar: { key: "orgUyushmalar", scope: "org" },
  orgLoyihalar: { key: "orgLoyihalar", scope: "org" },
  orgTasks: { key: "orgTasks", scope: "org" },
  orgDone: { key: "orgDone", scope: "org" },
  orgOpen: { key: "orgOpen", scope: "org" },
  orgOverdue: { key: "orgOverdue", scope: "org" },
  orgUnassigned: { key: "orgUnassigned", scope: "org" },

  /* Department and association breakdowns */
  deptTotal: { key: "deptTotal", scope: "department" },
  deptDone: { key: "deptDone", scope: "department" },
  deptOpen: { key: "deptOpen", scope: "department" },
  deptOverdue: { key: "deptOverdue", scope: "department" },
  uyushmaTotal: { key: "uyushmaTotal", scope: "uyushma" },
  uyushmaDone: { key: "uyushmaDone", scope: "uyushma" },
  uyushmaOpen: { key: "uyushmaOpen", scope: "uyushma" },
  uyushmaOverdue: { key: "uyushmaOverdue", scope: "uyushma" },
};

/** The reach of a figure, or `null` when the key is not a registered one. */
export function scopeOf(key: string): MetricScope | null {
  return METRICS[key]?.scope ?? null;
}
