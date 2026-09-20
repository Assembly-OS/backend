/**
 * What an agreement record must hold, with nothing that touches the database.
 *
 * The agreement of block 1.2 of the rebuild TZ: a document — or a word given
 * across a table — between named parties, under which each side owes things.
 * Kept free of imports so the form, a client component, and the tests can use
 * it, as `meeting-fields` is.
 */

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/**
 * What kind of agreement it is. The same ladder as a meeting's legal status,
 * less the two that describe talks rather than a paper — and plus the oral
 * agreement, which the TZ lists because the Assembly makes them and they bind
 * people all the same.
 */
export const KELISHUV_KINDS = [
  "MOU",
  "LOI",
  "TERM_SHEET",
  "CONTRACT",
  "ORAL",
] as const;
export type KelishuvKind = (typeof KELISHUV_KINDS)[number];

/** What is stored. */
export const KELISHUV_STATUSES = ["DRAFT", "OPEN", "DONE", "CANCELLED"] as const;
export type KelishuvStatus = (typeof KELISHUV_STATUSES)[number];

/** What a reader sees: the stored status, plus the one worked out. */
export type KelishuvView = KelishuvStatus | "EXPIRED";

/**
 * An open agreement whose term has run out reads as expired.
 *
 * Worked out, never stored — the same rule the commitments follow for
 * "overdue" — so there is no nightly job to forget and no row that says
 * "open" a week after its term ended.
 */
export function viewKelishuv(
  status: string,
  validUntil: string | null,
  today: string,
): KelishuvView {
  if (status === "OPEN" && validUntil && validUntil < today) return "EXPIRED";
  return (KELISHUV_STATUSES as readonly string[]).includes(status)
    ? (status as KelishuvStatus)
    : "DRAFT";
}

/** The currencies a sum may be recorded in. */
export const CURRENCIES = ["UZS", "USD", "EUR"] as const;
export type Currency = (typeof CURRENCIES)[number];

/* ------------------------------------------------------------------ */
/* Completeness                                                        */
/* ------------------------------------------------------------------ */

/**
 * The fields the TZ marks required, in the order a reader checks them.
 *
 * Judged, not refused, as with a meeting: a draft agreement typed in while the
 * terms are still moving is exactly the record that should exist, and refusing
 * it for want of a counterparty would lose it. Only the title is refused.
 */
export const KELISHUV_REQUIRED = [
  "kind",
  "parties",
  "project",
  "content",
  "obligations",
  "responsible",
] as const;
export type KelishuvField = (typeof KELISHUV_REQUIRED)[number];

export interface KelishuvShape {
  kind: string | null;
  party_count: number;
  loyiha_id: number | null;
  content: string | null;
  obligation_count: number;
  responsible_id: number | null;
}

const filled = (value: string | null | undefined) => Boolean(value?.trim());

/** The required fields this agreement still lacks. Empty means complete. */
export function missingKelishuv(kelishuv: KelishuvShape): KelishuvField[] {
  const has: Record<KelishuvField, boolean> = {
    kind: KELISHUV_KINDS.includes(kelishuv.kind as KelishuvKind),
    parties: kelishuv.party_count > 0,
    project: kelishuv.loyiha_id != null,
    content: filled(kelishuv.content),
    // "Each side's obligations as separate items": an agreement that binds
    // nobody to anything has not been written down yet.
    obligations: kelishuv.obligation_count > 0,
    responsible: kelishuv.responsible_id != null,
  };
  return KELISHUV_REQUIRED.filter((field) => !has[field]);
}

/** `K-0007` — cited the way a meeting is cited as `M-0142`. */
export function kelishuvCode(id: number): string {
  return `K-${String(id).padStart(4, "0")}`;
}
