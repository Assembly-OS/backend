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

/* ------------------------------------------------------------------ */
/* What the AI proposes                                                */
/* ------------------------------------------------------------------ */

/**
 * What the AI proposes for a meeting's record after reading its transcript —
 * block 1.1 of the rebuild TZ, step two: "the AI fills the fields, as a
 * suggestion", and step three: "a person reviews them".
 *
 * Nothing here is ever written into the record by itself. A suggestion is
 * offered only for a field the record leaves empty, shown marked in the form,
 * and becomes part of the meeting when a person saves it. The AI proposes; it
 * never overwrites what somebody typed.
 */

/** A suggestion, already resolved to rows that exist. Only present keys are suggested. */
export interface MeetingSuggestion {
  held_at?: string;
  place?: string;
  company_id?: number;
  /** The organisation as heard, kept only when it matched no company on file. */
  company_heard?: string;
  participants?: string;
  staff_ids?: number[];
  project_ids?: number[];
  description?: string;
  agreed?: string;
  open_issues?: string;
  next_steps?: string;
  responsible_id?: number;
  legal_status?: LegalStatus;
}

export type SuggestedField = Exclude<keyof MeetingSuggestion, "company_heard">;

/** In the order the form shows them, so a list of them reads down the form. */
export const SUGGESTED_FIELDS: readonly SuggestedField[] = [
  "held_at",
  "place",
  "company_id",
  "legal_status",
  "project_ids",
  "description",
  "agreed",
  "open_issues",
  "next_steps",
  "responsible_id",
  "participants",
  "staff_ids",
];

const blank = (value: unknown) =>
  value === null ||
  value === undefined ||
  (typeof value === "string" && !value.trim()) ||
  (Array.isArray(value) && value.length === 0);

/** The fields a suggestion actually proposes something for. */
export function suggestedFields(suggestion: MeetingSuggestion | null | undefined): SuggestedField[] {
  if (!suggestion) return [];
  return SUGGESTED_FIELDS.filter((key) => !blank(suggestion[key]));
}

/** The two fields that hold several rows; a suggestion adds to them. */
export const LIST_FIELDS = ["project_ids", "staff_ids"] as const;
const isList = (key: SuggestedField): key is (typeof LIST_FIELDS)[number] =>
  (LIST_FIELDS as readonly string[]).includes(key);

/**
 * What of the suggestion the record does not already hold.
 *
 * `current` is whatever the record or the form has now, and what a person put
 * there always stands. A single value is proposed only where the field is
 * empty. A list is only added to: the projects and people it does not have
 * yet — a new meeting starts with its author ticked as present, and that must
 * not stop the model naming who else was in the room.
 */
export function forEmpty(
  suggestion: MeetingSuggestion,
  current: Partial<Record<SuggestedField, unknown>>,
): MeetingSuggestion {
  const out: Record<string, unknown> = {};
  for (const key of SUGGESTED_FIELDS) {
    if (blank(suggestion[key])) continue;
    if (isList(key)) {
      const have = Array.isArray(current[key]) ? (current[key] as number[]) : [];
      const more = (suggestion[key] ?? []).filter((id) => !have.includes(id));
      if (more.length) out[key] = more;
      continue;
    }
    if (!blank(current[key])) continue;
    out[key] = suggestion[key];
  }
  if (suggestion.company_heard && out.company_id === undefined && blank(current.company_id))
    out.company_heard = suggestion.company_heard;
  return out as MeetingSuggestion;
}

/* ------------------------------------------------------------------ */
/* From the model's answer to rows that exist                          */
/* ------------------------------------------------------------------ */

/** The model's answer, as its output schema fixes it: "" or [] for "not said". */
export interface PrefillAnswer {
  held_at: string;
  place: string;
  company: string;
  participants: string;
  staff: string[];
  projects: string[];
  discussed: string;
  agreed: string;
  open_issues: string;
  next_step: string;
  responsible: string;
  legal_status: string;
}

/** What the answer is checked against. */
export interface PrefillRoster {
  /** Active staff, for who was in the room. */
  staff: { id: number; login: string }[];
  /** Who the reviewer may make responsible — the next step becomes their assignment. */
  responsibles: number[];
  projects: { id: number; code: string }[];
  companies: { id: number; name: string }[];
  /** The Assembly's today, 'YYYY-MM-DD'. A meeting with a transcript has happened. */
  today: string;
}

/**
 * Words for a company's legal form, which differ between how a name is said
 * and how it was filed: "Uzum" is "Uzum MChJ" on the card and «Узум» ООО in a
 * Russian sentence.
 */
const LEGAL_FORMS = new Set([
  "mchj", "aj", "xk", "qk", "ok", "dk", "llc", "ltd", "inc", "corp",
  "corporation", "co", "company", "gmbh", "plc", "ag", "sa", "jsc",
  "ооо", "оао", "зао", "пао", "ао", "ип", "мчж", "аж", "хк",
]);

/** A company name reduced to what identifies it. */
export function companyKey(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((word) => word && !LEGAL_FORMS.has(word))
    .join(" ");
}

/**
 * The company on file the model meant, or null.
 *
 * The same name first, then one name containing the other — but only when
 * exactly one company fits. Two candidates means the model's words do not
 * settle it, and a meeting filed under the wrong company is worse than one
 * filed under none.
 */
export function matchCompany(heard: string, companies: { id: number; name: string }[]): number | null {
  const key = companyKey(heard);
  if (key.length < 2) return null;
  const keyed = companies.map((company) => ({ id: company.id, key: companyKey(company.name) }));

  const same = keyed.filter((company) => company.key === key);
  if (same.length === 1) return same[0].id;
  if (same.length > 1) return null;

  // Containment only on names long enough to mean something; "ai" is inside
  // half the register.
  if (key.length < 4) return null;
  const near = keyed.filter(
    (company) =>
      company.key.length >= 4 && (company.key.includes(key) || key.includes(company.key)),
  );
  return near.length === 1 ? near[0].id : null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;

/**
 * Turns the model's answer into a suggestion that names only real rows.
 *
 * A login, a project code or a company the lists do not hold is dropped, not
 * guessed at; a date in the future is dropped, because a meeting with a
 * transcript has already taken place; a responsible person the reviewer could
 * not assign to is dropped, because saving the form would be refused for it.
 */
export function resolveSuggestion(answer: PrefillAnswer, roster: PrefillRoster): MeetingSuggestion {
  const out: MeetingSuggestion = {};

  const day = text(answer.held_at, 10);
  if (day && DAY.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && day <= roster.today)
    out.held_at = day;

  const place = text(answer.place, 200);
  if (place) out.place = place;

  const company = text(answer.company, 200);
  if (company) {
    const id = matchCompany(company, roster.companies);
    if (id !== null) out.company_id = id;
    else out.company_heard = company;
  }

  const participants = text(answer.participants, 1000);
  if (participants) out.participants = participants;

  const byLogin = new Map(roster.staff.map((person) => [person.login.toLowerCase(), person.id]));
  const staff = [
    ...new Set(
      (Array.isArray(answer.staff) ? answer.staff : [])
        .map((login) => byLogin.get(String(login).trim().toLowerCase()))
        .filter((id): id is number => id !== undefined),
    ),
  ].slice(0, 40);
  if (staff.length) out.staff_ids = staff;

  const byCode = new Map(roster.projects.map((project) => [project.code.toLowerCase(), project.id]));
  const projects = [
    ...new Set(
      (Array.isArray(answer.projects) ? answer.projects : [])
        .map((code) => byCode.get(String(code).trim().toLowerCase()))
        .filter((id): id is number => id !== undefined),
    ),
  ].slice(0, 20);
  if (projects.length) out.project_ids = projects;

  const description = text(answer.discussed, 4000);
  if (description) out.description = description;
  const agreed = text(answer.agreed, 4000);
  if (agreed) out.agreed = agreed;
  const open = text(answer.open_issues, 4000);
  if (open) out.open_issues = open;
  const next = text(answer.next_step, 4000);
  if (next) out.next_steps = next;

  const responsible = byLogin.get(String(answer.responsible ?? "").trim().toLowerCase());
  if (responsible !== undefined && roster.responsibles.includes(responsible))
    out.responsible_id = responsible;

  if (LEGAL_STATUSES.includes(answer.legal_status as LegalStatus))
    out.legal_status = answer.legal_status as LegalStatus;

  return out;
}

/** A stored suggestion read back, or null when there is none or it is unreadable. */
export function parseSuggestion(raw: string | null | undefined): MeetingSuggestion | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return suggestedFields(value as MeetingSuggestion).length ? (value as MeetingSuggestion) : null;
  } catch {
    return null;
  }
}
