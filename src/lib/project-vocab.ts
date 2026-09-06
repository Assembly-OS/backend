/**
 * The vocabulary of a project workspace, and nothing else.
 *
 * Split out for one blunt reason: `project-threads.ts` and `projects.ts` both
 * open a Postgres pool at import time, and the two forms that create a
 * project and a thread are Client Components that need these lists. Importing
 * the constants from those modules pulled `pg` into the browser bundle and
 * the build stopped — the same trap `lib/admin` documents for `node:sqlite`.
 *
 * So everything a client component may legitimately need lives here: plain
 * values, plain functions, no database. Both server modules re-export all of
 * it, so server code carries on importing from where it always did.
 */

/**
 * Where a project stands.
 *
 * `FAOL` and `YAKUNLANMOQDA` are the original pair and keep their exact
 * meaning — every row already in the register carries one of them, and
 * renaming either would have rewritten history to make a list look tidier.
 * The other three are what running a project as a workspace turned out to
 * need: work that has not started, work parked on somebody else, and work
 * that is finished rather than finishing.
 */
export const PROJECT_STATUSES = [
  "REJA",
  "FAOL",
  "PAUZA",
  "YAKUNLANMOQDA",
  "YAKUNLANDI",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** A project carries the same four priorities an assignment does. */
export const PROJECT_PRIORITIES = ["PAST", "ORTA", "YUQORI", "KRITIK"] as const;

/** What a thread is about. Decides an icon; a thread is otherwise a thread. */
export const THREAD_KINDS = ["ORG", "DIRECTION", "INTERNAL"] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];

/**
 * What kind of record an entry is.
 *
 * The kinds are not decoration: they are what lets a year of a thread be
 * skimmed. "When did we last actually meet them" is answered by the MEETING
 * marks alone, and no amount of reading paragraphs replaces that.
 */
export const ENTRY_KINDS = [
  "NOTE",
  "MEETING",
  "AGREEMENT",
  "FILE",
  "LINK",
] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export function threadKind(value: unknown): ThreadKind {
  return THREAD_KINDS.includes(value as ThreadKind)
    ? (value as ThreadKind)
    : "ORG";
}

export function entryKind(value: unknown): EntryKind {
  return ENTRY_KINDS.includes(value as EntryKind) ? (value as EntryKind) : "NOTE";
}

/**
 * The day an entry belongs to in the journal.
 *
 * `occurred_on` when the writer supplied one, otherwise the day it was
 * written. Both are already Assembly-time calendar days by the time they are
 * stored, so this is a choice, not a conversion.
 */
export function entryDay(entry: {
  occurred_on: string | null;
  created_at: string;
}): string {
  return entry.occurred_on ?? entry.created_at.slice(0, 10);
}
