import type { SourceKind } from "./text";

export { SOURCE_KINDS, isSourceKind, RELIABILITY } from "./text";
export type { SourceKind } from "./text";

/**
 * The shapes the memory stores and shows. No database import, so the pages
 * and the client components can type against them.
 */

/** Where a source stands. PENDING → PROCESSING → READY | PARTIAL | FAILED;
 *  SKIPPED for a record with nothing worth reading; DELETED when the record
 *  it came from is gone. */
export type SourceStatus =
  | "PENDING"
  | "PROCESSING"
  | "READY"
  | "PARTIAL"
  | "FAILED"
  | "DELETED"
  | "SKIPPED";

/** Why a source is FAILED, PARTIAL or SKIPPED — a code the UI translates. */
export type SourceReason =
  | "NO_KEY"
  | "UNSUPPORTED"
  | "EMPTY"
  | "REFUSED"
  | "ERROR"
  | "TOO_LONG"
  | "STT_UNAVAILABLE"
  | "BAD_AUDIO"
  | "GONE"
  | "SHORT"
  | "FAILED"
  | "FILE_UNREAD";

export interface SourceRow {
  id: number;
  kind: SourceKind;
  ref_id: number;
  version: number;
  fingerprint: string | null;
  title: string;
  author_id: number | null;
  occurred_at: string | null;
  lang: string | null;
  project_id: number | null;
  company_id: number | null;
  meeting_id: number | null;
  task_id: number | null;
  thread_id: number | null;
  group_id: number | null;
  from_user_id: number | null;
  to_user_id: number | null;
  uyushma_id: number | null;
  reliability: number;
  status: SourceStatus;
  reason: SourceReason | null;
  text_chars: number;
  chunk_count: number;
  facts_at: string | null;
  embedded_at: string | null;
  indexed_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A source as a page lists it: with names, a link and the last error. */
export interface SourceView extends SourceRow {
  author_name: string | null;
  project_code: string | null;
  project_name: string | null;
  /** The last job's error, when one failed. */
  last_error: string | null;
  href: string;
}

export interface ChunkRow {
  id: number;
  source_id: number;
  version: number;
  position: number;
  section: string | null;
  body: string;
}

export const FACT_KINDS = [
  "decision",
  "commitment",
  "action_item",
  "deadline",
  "fact",
  "risk",
] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export interface FactRow {
  id: number;
  source_id: number;
  version: number;
  chunk_id: number | null;
  kind: FactKind;
  subject: string | null;
  statement: string;
  who: string | null;
  who_user_id: number | null;
  due_on: string | null;
  stated: "direct" | "inferred";
  confidence: number;
  quote: string | null;
  task_id: number | null;
  status: "proposed" | "confirmed" | "rejected";
  created_at: string;
}

/**
 * Where a source's original record is opened. The chat needs the viewer:
 * a one-to-one conversation is addressed by the *other* person's login.
 */
export function hrefFor(
  source: Pick<
    SourceRow,
    "kind" | "ref_id" | "project_id" | "thread_id" | "group_id" | "company_id" | "from_user_id"
  > & { other_login?: string | null },
): string {
  switch (source.kind) {
    case "task":
      return source.project_id ? `/projects/${source.project_id}` : "/tasks/inbox";
    case "meeting":
      return `/meetings/${source.ref_id}`;
    case "thread_entry":
      return source.project_id && source.thread_id
        ? `/projects/${source.project_id}/${source.thread_id}`
        : "/projects";
    case "message":
      if (source.group_id) return `/chat/group/${source.group_id}`;
      return source.other_login ? `/chat/${encodeURIComponent(source.other_login)}` : "/chat";
    case "project_document":
    case "project":
      return source.project_id ? `/projects/${source.project_id}` : "/projects";
    case "library":
      return `/knowledge/${source.ref_id}`;
    case "uyushma":
      return `/associations/${source.ref_id}`;
    case "kelishuv":
      return `/agreements/${source.ref_id}`;
    case "agreement":
      return source.company_id ? `/companies/${source.company_id}` : "/agreements";
    default:
      return "/knowledge";
  }
}

/** The evidence page for a source: its passages and facts, as the AI sees them. */
export function evidenceHref(sourceId: number): string {
  return `/knowledge/sources/${sourceId}`;
}
