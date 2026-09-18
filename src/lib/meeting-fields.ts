/**
 * What a meeting record must hold, with nothing that touches the database.
 *
 * Split from `lib/meetings` so the form — a client component — and the tests
 * can import it: that module reads Postgres, and importing it into the browser
 * bundle would drag the driver in with it.
 */

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/**
 * How far the talks have come.
 *
 * The TZ's rule behind it: an agreement that has not been signed is never
 * reported as concluded. Without this field a memorandum of understanding and
 * a signed contract look the same in a report, and the report is wrong.
 */
export const LEGAL_STATUSES = [
  "NEGOTIATION",
  "MOU",
  "LOI",
  "TERM_SHEET",
  "CONTRACT",
  "STOPPED",
] as const;
export type LegalStatus = (typeof LEGAL_STATUSES)[number];

/**
 * The fields the TZ marks required, in the order a reader checks them.
 *
 * Required does not mean refused. A meeting missing any of these is saved and
 * marked incomplete, which is how the TZ itself treats a project passport, and
 * how its own intake flow works: the AI fills the fields from a transcript as
 * a suggestion and a person completes them afterwards. Refusing the save would
 * turn the half-filled record into no record at all, which is the one outcome
 * the memory contour exists to prevent.
 *
 * `projects` is in the list although a first meeting with a company belongs
 * to no project yet. Such a meeting is saved like any other and shows as
 * incomplete: the TZ's first rule is that a meeting with no project leaves no
 * trace in the memory, and the marker is how that gap stays visible.
 */
export const MEETING_REQUIRED = [
  "held_at",
  "company",
  "projects",
  "external",
  "staff",
  "discussed",
  "agreed",
  "next_step",
  "legal_status",
] as const;
export type MeetingField = (typeof MEETING_REQUIRED)[number];

/** What completeness is judged on — a subset of a row, however it was read. */
export interface MeetingShape {
  held_at: string | null;
  company_id: number | null;
  project_count: number;
  participants: string | null;
  staff_count: number;
  description: string | null;
  agreed: string | null;
  next_steps: string | null;
  responsible_id: number | null;
  legal_status: string | null;
}

const filled = (value: string | null | undefined) => Boolean(value?.trim());

/** The required fields this meeting still lacks. Empty means complete. */
export function missingFields(meeting: MeetingShape): MeetingField[] {
  const has: Record<MeetingField, boolean> = {
    held_at: filled(meeting.held_at),
    company: meeting.company_id != null,
    projects: meeting.project_count > 0,
    external: filled(meeting.participants),
    staff: meeting.staff_count > 0,
    discussed: filled(meeting.description),
    agreed: filled(meeting.agreed),
    // A next step nobody answers for is not a next step.
    next_step: filled(meeting.next_steps) && meeting.responsible_id != null,
    legal_status: LEGAL_STATUSES.includes(meeting.legal_status as LegalStatus),
  };
  return MEETING_REQUIRED.filter((field) => !has[field]);
}

/** `M-0142` — how the TZ cites a meeting as the source of what it says. */
export function meetingCode(id: number): string {
  return `M-${String(id).padStart(4, "0")}`;
}
