/**
 * The kinds of document a project passport holds, TZ block 1.3: "Master-plan,
 * TIA, ESG, huquqiy hujjatlar". Plain values with no database import, so the
 * upload form — a Client Component — can use them without pulling the
 * Postgres driver into the browser bundle.
 */
export const DOCUMENT_KINDS = ["MASTER_PLAN", "TIA", "ESG", "LEGAL", "OTHER"] as const;

export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export function isDocumentKind(value: unknown): value is DocumentKind {
  return (DOCUMENT_KINDS as readonly unknown[]).includes(value);
}
