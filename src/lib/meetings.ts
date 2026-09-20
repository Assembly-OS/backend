import { all, get, now, run, type Tx } from "./pg";
import { assignableUsers } from "./queries";
import type { User } from "./types";
import {
  forEmpty,
  parseSuggestion,
  suggestedFields,
  type MeetingShape,
  type MeetingSuggestion,
} from "./meeting-fields";

export {
  LEGAL_STATUSES,
  MEETING_REQUIRED,
  meetingCode,
  missingFields,
  type LegalStatus,
  type MeetingField,
  type MeetingShape,
} from "./meeting-fields";

/**
 * The meeting record, as block 1.1 of the rebuild TZ defines it.
 *
 * The TZ opens with the question this has to answer years later, after the
 * people in the room have left: "on 11.09.2026 we negotiated with Parsons; it
 * was said …; it was agreed …; responsible …; source: meeting M-0142." Before
 * this there was a transcript with a company attached, and none of those
 * answers had a field to live in.
 */

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

export interface MeetingDetail extends MeetingShape {
  id: number;
  title: string;
  owner_id: number;
  owner_name: string;
  place: string | null;
  open_issues: string | null;
  uyushma_id: number | null;
  uyushma_name: string | null;
  company_name: string | null;
  responsible_name: string | null;
  next_task_id: number | null;
  next_task_code: string | null;
  next_task_status: string | null;
  transcript: string;
  lang: string;
  duration: number | null;
  has_audio: boolean;
  created_at: string;
  updated_at: string | null;
  projects: { id: number; code: string; name: string }[];
  staff: { id: number; full_name: string }[];
  summary: string | null;
  /** What the AI proposed for the empty fields, waiting for a person to review. */
  suggestion: MeetingSuggestion | null;
}

/**
 * One meeting with everything attached to it.
 *
 * `lang` picks which stored conclusion comes back — the analysis writes one
 * per language, and Cyrillic Uzbek reads the Latin row.
 */
export async function meetingById(
  id: number,
  lang: "uz" | "ru" | "en" = "uz",
): Promise<MeetingDetail | undefined> {
  const row = await get<
    Omit<MeetingDetail, "projects" | "staff" | "suggestion"> & { ai_fields: string | null }
  >(
    `SELECT m.id, m.title, m.owner_id, m.company_id, m.held_at, m.place,
            m.participants, m.responsible_id, m.description, m.agreed,
            m.open_issues, m.next_steps, m.legal_status, m.uyushma_id,
            m.next_task_id, m.transcript, m.lang, m.duration, m.ai_fields,
            (m.audio_key IS NOT NULL) AS has_audio, m.created_at, m.updated_at,
            p.name AS company_name, o.full_name AS owner_name,
            r.full_name AS responsible_name, u.name AS uyushma_name,
            t.code AS next_task_code, t.status AS next_task_status,
            c.summary,
            (SELECT COUNT(*) FROM meeting_projects mp WHERE mp.meeting_id = m.id) AS project_count,
            (SELECT COUNT(*) FROM meeting_staff ms WHERE ms.meeting_id = m.id) AS staff_count
       FROM meetings m
       JOIN users o ON o.id = m.owner_id
       LEFT JOIN partners p ON p.id = m.company_id
       LEFT JOIN users r ON r.id = m.responsible_id
       LEFT JOIN uyushmalar u ON u.id = m.uyushma_id
       LEFT JOIN tasks t ON t.id = m.next_task_id
       LEFT JOIN meeting_conclusions c ON c.meeting_id = m.id AND c.lang = ?
      WHERE m.id = ?`,
    lang,
    id,
  );
  if (!row) return undefined;

  const [projects, staff] = await Promise.all([
    all<{ id: number; code: string; name: string }>(
      `SELECT l.id, l.code, l.name
         FROM meeting_projects mp JOIN loyihalar l ON l.id = mp.project_id
        WHERE mp.meeting_id = ?
        ORDER BY l.code`,
      id,
    ),
    all<{ id: number; full_name: string }>(
      `SELECT u.id, u.full_name
         FROM meeting_staff ms JOIN users u ON u.id = ms.user_id
        WHERE ms.meeting_id = ?
        ORDER BY u.full_name`,
      id,
    ),
  ]);

  const { ai_fields, ...rest } = row;
  // Judged against the record as it is now, not as it was when the model
  // answered: a field filled since then has nothing left to suggest.
  const stored = parseSuggestion(ai_fields);
  const open = stored
    ? forEmpty(stored, {
        ...rest,
        project_ids: projects.map((project) => project.id),
        staff_ids: staff.map((person) => person.id),
      })
    : null;
  return {
    ...rest,
    projects,
    staff,
    suggestion: open && suggestedFields(open).length ? open : null,
  };
}

/**
 * Keeps what the AI proposed for a meeting, for a person to review.
 *
 * Only what the record does not hold is kept — at the moment of writing, and
 * again whenever it is read — so a suggestion never stands over something a
 * person typed. Nothing left to propose
 * clears it. Saving the meeting through the form clears it too: the person
 * has seen every suggestion by then, and kept or dropped each.
 */
export async function storeSuggestion(
  meetingId: number,
  suggestion: MeetingSuggestion,
): Promise<void> {
  const current = await get<{
    held_at: string | null;
    place: string | null;
    company_id: number | null;
    participants: string | null;
    description: string | null;
    agreed: string | null;
    open_issues: string | null;
    next_steps: string | null;
    responsible_id: number | null;
    legal_status: string | null;
  }>(
    `SELECT held_at, place, company_id, participants, description, agreed,
            open_issues, next_steps, responsible_id, legal_status
       FROM meetings WHERE id = ?`,
    meetingId,
  );
  if (!current) return;
  const [projects, staff] = await Promise.all([
    all<{ id: number }>("SELECT project_id AS id FROM meeting_projects WHERE meeting_id = ?", meetingId),
    all<{ id: number }>("SELECT user_id AS id FROM meeting_staff WHERE meeting_id = ?", meetingId),
  ]);
  const open = forEmpty(suggestion, {
    ...current,
    project_ids: projects.map((row) => row.id),
    staff_ids: staff.map((row) => row.id),
  });
  await run(
    "UPDATE meetings SET ai_fields = ?, ai_fields_at = ? WHERE id = ?",
    suggestedFields(open).length ? JSON.stringify(open) : null,
    now(),
    meetingId,
  );
}

export interface MeetingListRow extends MeetingShape {
  id: number;
  title: string;
  happened: string;
  company_name: string | null;
  summary: string | null;
}

export const MEETING_PAGE = 30;

/** `%text%` for ILIKE, with the wildcard characters in the text made literal. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, "\\$&")}%`;
}

/**
 * Meetings, newest first, narrowed by a search and by company or project.
 *
 * The search reads the company name, the title, what was discussed, what was
 * agreed and who was there — the TZ's own test is "search by company name and
 * every meeting comes back by date". Paged on the server: this list grows by
 * the week and an unbounded one becomes a very long page on a phone.
 */
export async function searchMeetings(filter: {
  query?: string;
  companyId?: number | null;
  projectId?: number | null;
  lang?: "uz" | "ru" | "en";
  page?: number;
}): Promise<{ rows: MeetingListRow[]; total: number }> {
  const where: string[] = [];
  const params: (string | number)[] = [];

  const query = filter.query?.trim();
  if (query) {
    const like = likePattern(query);
    where.push(
      `(p.name ILIKE ? OR m.title ILIKE ? OR m.description ILIKE ?
        OR m.agreed ILIKE ? OR m.participants ILIKE ?)`,
    );
    params.push(like, like, like, like, like);
  }
  if (filter.companyId) {
    where.push("m.company_id = ?");
    params.push(filter.companyId);
  }
  if (filter.projectId) {
    where.push(
      "m.id IN (SELECT meeting_id FROM meeting_projects WHERE project_id = ?)",
    );
    params.push(filter.projectId);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = Number(
    (
      await get<{ n: number }>(
        `SELECT COUNT(*) AS n
           FROM meetings m LEFT JOIN partners p ON p.id = m.company_id
         ${clause}`,
        ...params,
      )
    )?.n ?? 0,
  );

  const page = Math.max(0, filter.page ?? 0);
  const rows = await all<MeetingListRow>(
    `SELECT m.id, m.title, COALESCE(m.held_at, m.created_at) AS happened,
            m.held_at, m.company_id, m.participants, m.description, m.agreed,
            m.next_steps, m.responsible_id, m.legal_status,
            p.name AS company_name, c.summary,
            (SELECT COUNT(*) FROM meeting_projects mp WHERE mp.meeting_id = m.id) AS project_count,
            (SELECT COUNT(*) FROM meeting_staff ms WHERE ms.meeting_id = m.id) AS staff_count
       FROM meetings m
       LEFT JOIN partners p ON p.id = m.company_id
       LEFT JOIN meeting_conclusions c ON c.meeting_id = m.id AND c.lang = ?
     ${clause}
      ORDER BY happened DESC, m.id DESC
      LIMIT ? OFFSET ?`,
    filter.lang ?? "uz",
    ...params,
    MEETING_PAGE,
    page * MEETING_PAGE,
  );

  return { rows, total };
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Makes a link table say exactly `wanted` for this meeting.
 *
 * Only the links that changed are touched. Replacing the whole set on every
 * save would be simpler, but every link removed is copied into `archive` by
 * the database, and an edit that changed nothing would archive the whole set
 * each time — burying the removals that actually happened.
 */
async function syncLinks(
  q: Tx,
  table: "meeting_projects" | "meeting_staff",
  column: "project_id" | "user_id",
  meetingId: number,
  wanted: number[],
): Promise<void> {
  const ids = [...new Set(wanted)];
  if (ids.length === 0) {
    await q.run(`DELETE FROM ${table} WHERE meeting_id = ?`, meetingId);
    return;
  }
  await q.run(
    `DELETE FROM ${table}
      WHERE meeting_id = ? AND ${column} NOT IN (${ids.map(() => "?").join(",")})`,
    meetingId,
    ...ids,
  );
  for (const id of ids) {
    await q.run(
      `INSERT INTO ${table} (meeting_id, ${column}) VALUES (?, ?)
       ON CONFLICT DO NOTHING`,
      meetingId,
      id,
    );
  }
}

/** Which projects and which Assembly people this meeting is linked to. */
export async function setMeetingLinks(
  q: Tx,
  meetingId: number,
  projectIds: number[],
  staffIds: number[],
): Promise<void> {
  await syncLinks(q, "meeting_projects", "project_id", meetingId, projectIds);
  await syncLinks(q, "meeting_staff", "user_id", meetingId, staffIds);
}

/* ------------------------------------------------------------------ */
/* Form                                                                */
/* ------------------------------------------------------------------ */

type Option = { id: number; label: string; hint?: string | null };

/**
 * Everything the meeting form offers to choose from.
 *
 * Two different lists of people, on purpose. Who may be named responsible is
 * who the author may assign to, because the next step becomes their
 * assignment. Who may be marked as having been in the room is anyone active —
 * the chairman included, who attends meetings but receives no assignments.
 */
export async function meetingFormOptions(user: User): Promise<{
  companies: Option[];
  responsibles: Option[];
  people: Option[];
  projects: Option[];
  uyushmalar: Option[];
}> {
  const [companyRows, assignable, people, projectRows, uyushmaRows] =
    await Promise.all([
      all<{ id: number; name: string }>(
        "SELECT id, name FROM partners ORDER BY name",
      ),
      assignableUsers(user),
      all<{ id: number; full_name: string; position: string | null }>(
        "SELECT id, full_name, position FROM users WHERE is_active = 1 ORDER BY full_name",
      ),
      all<{ id: number; code: string; name: string }>(
        "SELECT id, code, name FROM loyihalar ORDER BY code",
      ),
      all<{ id: number; name: string }>(
        "SELECT id, name FROM uyushmalar ORDER BY name",
      ),
    ]);

  return {
    companies: companyRows.map((row) => ({ id: row.id, label: row.name })),
    responsibles: assignable.map((person) => ({
      id: person.id,
      label: person.full_name,
    })),
    people: people.map((person) => ({
      id: person.id,
      label: person.full_name,
      hint: person.position,
    })),
    projects: projectRows.map((row) => ({
      id: row.id,
      label: `${row.code} · ${row.name}`,
    })),
    uyushmalar: uyushmaRows.map((row) => ({ id: row.id, label: row.name })),
  };
}
