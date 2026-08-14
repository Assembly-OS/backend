import { all, get, now, run } from "./db";
import { notify } from "./notifications";

/**
 * The CRM half of the platform: companies, the people inside them, the
 * meetings held with them, what was agreed, and when to be reminded.
 *
 * One decision runs through all of it. **"Overdue" is never stored.** An
 * agreement carries the status somebody set — new, in progress, done,
 * cancelled — and whether it is late is computed from its deadline every time
 * it is read. Storing it would mean a nightly job, and a nightly job means a
 * row that is wrong between midnight and whenever the job runs. Derived, it is
 * right at every instant and there is nothing to schedule.
 *
 * Dates: a deadline is a calendar day the user typed and is compared against
 * the calendar day in Assembly time. Everything else is a UTC instant, as
 * everywhere else in this database.
 */

/* ------------------------------------------------------------------ */
/* Shared vocabulary                                                   */
/* ------------------------------------------------------------------ */

export const COMPANY_STATUSES = [
  "POTENTIAL",
  "ACTIVE",
  "PAUSED",
  "ARCHIVED",
] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export const AGREEMENT_STATUSES = [
  "NEW",
  "IN_PROGRESS",
  "DONE",
  "CANCELLED",
] as const;
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];

/** What a reader sees — the stored status, plus the one we work out. */
export type AgreementView = AgreementStatus | "OVERDUE";

export const PRIORITIES = ["PAST", "ORTA", "YUQORI", "KRITIK"] as const;

/**
 * Today in Assembly time, as `YYYY-MM-DD`.
 *
 * Not `date('now')`: SQLite's is UTC, which for the five hours after midnight
 * local reports yesterday — and would mark a deadline overdue a day early
 * every single morning.
 */
export function today(): string {
  const zone = process.env.NEXT_PUBLIC_TIME_ZONE || "Asia/Tashkent";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function addDays(isoDate: string, days: number): string {
  const at = new Date(`${isoDate}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** The status a reader should see, deadline taken into account. */
export function viewStatus(
  status: string,
  deadline: string | null,
): AgreementView {
  if (status === "DONE" || status === "CANCELLED") return status;
  if (deadline && deadline < today()) return "OVERDUE";
  return (status as AgreementStatus) ?? "NEW";
}

/* ------------------------------------------------------------------ */
/* Companies                                                           */
/* ------------------------------------------------------------------ */

export interface Company {
  id: number;
  name: string;
  description: string | null;
  industry: string | null;
  direction: string | null;
  services: string | null;
  sector: string | null;
  country: string | null;
  city: string | null;
  address: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  head_name: string | null;
  head_position: string | null;
  status: string;
  started_at: string | null;
  last_contact_at: string | null;
  next_contact_at: string | null;
  notes: string | null;
  owner_user_id: number | null;
  created_at: string | null;
  updated_at: string | null;
  /** Written by the AI intake before the CRM existed; still the oldest signal. */
  first_seen: string | null;
  last_seen: string | null;
}

export interface CompanyRow extends Company {
  owner_name: string | null;
  meetings: number;
  agreements: number;
  open_agreements: number;
  contacts: number;
}

/** The list view: every company with the counts that make the row useful. */
export function companies(filter?: {
  status?: string;
  query?: string;
}): CompanyRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filter?.status && filter.status !== "ALL") {
    where.push("p.status = ?");
    params.push(filter.status);
  }
  if (filter?.query) {
    // Cast a wide net: a person searching "logistics" means the industry or
    // the services text just as often as the name.
    where.push(
      `(p.name LIKE ? COLLATE NOCASE OR p.industry LIKE ? COLLATE NOCASE
        OR p.services LIKE ? COLLATE NOCASE OR p.city LIKE ? COLLATE NOCASE
        OR p.head_name LIKE ? COLLATE NOCASE)`,
    );
    const like = `%${filter.query}%`;
    params.push(like, like, like, like, like);
  }

  return all<CompanyRow>(
    `SELECT p.*,
            u.full_name AS owner_name,
            (SELECT COUNT(*) FROM meetings m WHERE m.company_id = p.id) AS meetings,
            (SELECT COUNT(*) FROM agreements a WHERE a.company_id = p.id) AS agreements,
            (SELECT COUNT(*) FROM agreements a
              WHERE a.company_id = p.id AND a.status IN ('NEW','IN_PROGRESS')) AS open_agreements,
            (SELECT COUNT(*) FROM contacts c WHERE c.company_id = p.id) AS contacts
       FROM partners p
       LEFT JOIN users u ON u.id = p.owner_user_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY COALESCE(p.last_contact_at, p.last_seen, p.created_at) DESC
      LIMIT 300`,
    ...params,
  );
}

export function companyById(id: number): CompanyRow | undefined {
  return companies().find((company) => company.id === id);
}

const COMPANY_FIELDS = [
  "name",
  "description",
  "industry",
  "direction",
  "services",
  "country",
  "city",
  "address",
  "website",
  "email",
  "phone",
  "head_name",
  "head_position",
  "status",
  "started_at",
  "next_contact_at",
  "notes",
  "owner_user_id",
] as const;

export type CompanyInput = Partial<
  Record<(typeof COMPANY_FIELDS)[number], string | number | null>
> & { name: string };

export function createCompany(input: CompanyInput): number {
  const columns = COMPANY_FIELDS.filter((key) => input[key] !== undefined);
  run(
    `INSERT INTO partners (${columns.join(",")}, first_seen, last_seen, created_at, updated_at)
     VALUES (${columns.map(() => "?").join(",")},?,?,?,?)`,
    ...columns.map((key) => input[key] ?? null),
    now(),
    now(),
    now(),
    now(),
  );
  return Number(get<{ id: number }>("SELECT MAX(id) AS id FROM partners")!.id);
}

export function updateCompany(id: number, input: CompanyInput): void {
  const columns = COMPANY_FIELDS.filter((key) => input[key] !== undefined);
  if (columns.length === 0) return;
  run(
    `UPDATE partners SET ${columns.map((c) => `${c} = ?`).join(", ")}, updated_at = ?
      WHERE id = ?`,
    ...columns.map((key) => input[key] ?? null),
    now(),
    id,
  );
}

/** Called whenever a meeting is filed, so the card's dates stay honest. */
export function touchCompany(id: number, when: string): void {
  run(
    `UPDATE partners
        SET last_contact_at = CASE
              WHEN last_contact_at IS NULL OR last_contact_at < ? THEN ? ELSE last_contact_at END,
            last_seen = ?, updated_at = ?
      WHERE id = ?`,
    when,
    when,
    now(),
    now(),
    id,
  );
}

/* ------------------------------------------------------------------ */
/* Contacts                                                            */
/* ------------------------------------------------------------------ */

export interface Contact {
  id: number;
  company_id: number;
  first_name: string;
  last_name: string;
  position: string | null;
  phone: string | null;
  email: string | null;
  telegram: string | null;
  is_head: number;
  note: string | null;
}

export function contactsOf(companyId: number): Contact[] {
  return all<Contact>(
    "SELECT * FROM contacts WHERE company_id = ? ORDER BY is_head DESC, id",
    companyId,
  );
}

export interface ContactInput {
  company_id: number;
  first_name: string;
  last_name?: string;
  position?: string | null;
  phone?: string | null;
  email?: string | null;
  telegram?: string | null;
  is_head?: boolean;
  note?: string | null;
}

export function createContact(input: ContactInput): number {
  // One head per company: promoting a new one demotes the old, rather than
  // leaving two people both labelled as the person in charge.
  if (input.is_head) {
    run("UPDATE contacts SET is_head = 0 WHERE company_id = ?", input.company_id);
  }
  run(
    `INSERT INTO contacts
       (company_id, first_name, last_name, position, phone, email, telegram,
        is_head, note, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    input.company_id,
    input.first_name,
    input.last_name ?? "",
    input.position ?? null,
    input.phone ?? null,
    input.email ?? null,
    input.telegram ?? null,
    input.is_head ? 1 : 0,
    input.note ?? null,
    now(),
    now(),
  );
  const id = Number(get<{ id: number }>("SELECT MAX(id) AS id FROM contacts")!.id);

  // The card shows a head; keep it in step with the contact marked as one.
  if (input.is_head) {
    run(
      "UPDATE partners SET head_name = ?, head_position = ?, updated_at = ? WHERE id = ?",
      `${input.first_name} ${input.last_name ?? ""}`.trim(),
      input.position ?? null,
      now(),
      input.company_id,
    );
  }
  return id;
}

export function deleteContact(id: number): void {
  run("DELETE FROM contacts WHERE id = ?", id);
}

/* ------------------------------------------------------------------ */
/* Agreements                                                          */
/* ------------------------------------------------------------------ */

export interface AgreementRow {
  id: number;
  company_id: number | null;
  company_name: string | null;
  meeting_id: number | null;
  meeting_title: string | null;
  task_id: number | null;
  description: string;
  owner_user_id: number | null;
  owner_full_name: string | null;
  owner_name: string | null;
  deadline: string | null;
  status: string;
  priority: string;
  note: string | null;
  source: string;
  created_at: string;
  done_at: string | null;
}

const AGREEMENT_SELECT = `
  SELECT a.*, p.name AS company_name, m.title AS meeting_title,
         u.full_name AS owner_full_name
    FROM agreements a
    LEFT JOIN partners p ON p.id = a.company_id
    LEFT JOIN meetings m ON m.id = a.meeting_id
    LEFT JOIN users u ON u.id = a.owner_user_id`;

export function agreementsOf(companyId: number): AgreementRow[] {
  return all<AgreementRow>(
    `${AGREEMENT_SELECT} WHERE a.company_id = ? ORDER BY a.id DESC`,
    companyId,
  );
}

export function agreementById(id: number): AgreementRow | undefined {
  return get<AgreementRow>(`${AGREEMENT_SELECT} WHERE a.id = ?`, id);
}

/**
 * The three buckets the reminders page is built from.
 *
 * `mine` narrows to one person's own commitments — an employee opening the
 * page should see their week, not the Assembly's.
 */
export function agreementBoard(mine?: number): {
  overdue: AgreementRow[];
  todayList: AgreementRow[];
  soon: AgreementRow[];
  later: AgreementRow[];
  noDeadline: AgreementRow[];
} {
  const scope = mine ? " AND a.owner_user_id = ?" : "";
  const params = mine ? [mine] : [];
  const open = all<AgreementRow>(
    `${AGREEMENT_SELECT}
      WHERE a.status IN ('NEW','IN_PROGRESS')${scope}
      ORDER BY a.deadline IS NULL, a.deadline, a.id DESC`,
    ...params,
  );

  const day = today();
  const horizon = addDays(day, 7);
  return {
    overdue: open.filter((a) => a.deadline && a.deadline < day),
    todayList: open.filter((a) => a.deadline === day),
    soon: open.filter((a) => a.deadline && a.deadline > day && a.deadline <= horizon),
    later: open.filter((a) => a.deadline && a.deadline > horizon),
    noDeadline: open.filter((a) => !a.deadline),
  };
}

export interface AgreementInput {
  company_id?: number | null;
  meeting_id?: number | null;
  description: string;
  owner_user_id?: number | null;
  owner_name?: string | null;
  deadline?: string | null;
  status?: string;
  priority?: string;
  note?: string | null;
  source?: string;
  created_by?: number | null;
}

export function createAgreement(input: AgreementInput): number {
  run(
    `INSERT INTO agreements
       (company_id, meeting_id, description, owner_user_id, owner_name,
        deadline, status, priority, note, source, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    input.company_id ?? null,
    input.meeting_id ?? null,
    input.description.slice(0, 1000),
    input.owner_user_id ?? null,
    input.owner_name ?? null,
    input.deadline ?? null,
    input.status ?? "NEW",
    input.priority ?? "ORTA",
    input.note ?? null,
    input.source ?? "manual",
    input.created_by ?? null,
    now(),
  );
  const id = Number(get<{ id: number }>("SELECT MAX(id) AS id FROM agreements")!.id);

  if (input.owner_user_id) {
    // Told now that it is theirs; reminded again as the date approaches.
    notify({
      userId: input.owner_user_id,
      kind: "agreement",
      title: input.description.slice(0, 120),
      body: input.deadline ?? "",
      href: input.company_id ? `/companies/${input.company_id}` : "/agreements",
      entity: "agreement",
      entityId: id,
    });
    // A commitment with a date gets its reminder immediately — the whole point
    // of recording it is that somebody is told in time.
    if (input.deadline) {
      scheduleReminder(id, input.owner_user_id, input.deadline, input.description);
    }
  }
  return id;
}

export function setAgreementStatus(id: number, status: string): void {
  run(
    `UPDATE agreements SET status = ?, done_at = ? WHERE id = ?`,
    status,
    status === "DONE" ? now() : null,
    id,
  );
  // A settled agreement stops nagging.
  if (status === "DONE" || status === "CANCELLED") {
    run(
      "UPDATE reminders SET status = 'DISMISSED' WHERE agreement_id = ? AND status = 'PENDING'",
      id,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Reminders                                                           */
/* ------------------------------------------------------------------ */

export interface ReminderRow {
  id: number;
  agreement_id: number | null;
  user_id: number;
  remind_at: string;
  kind: string;
  status: string;
  message: string;
  description: string | null;
  company_name: string | null;
  deadline: string | null;
}

/**
 * Two reminders per deadline: one the day before, one on the day. Earlier than
 * that is noise a week out; later than that is too late to act.
 */
export function scheduleReminder(
  agreementId: number,
  userId: number,
  deadline: string,
  message: string,
): void {
  const day = today();
  for (const [when, kind] of [
    [addDays(deadline, -1), "followup"],
    [deadline, "deadline"],
  ] as const) {
    // Never schedule into the past — a deadline set for yesterday should show
    // up as overdue, not fire a reminder that was already missed.
    if (when < day) continue;
    run(
      `INSERT INTO reminders (agreement_id, user_id, remind_at, kind, status, message, created_at)
       VALUES (?,?,?,?,'PENDING',?,?)`,
      agreementId,
      userId,
      `${when} 04:00:00`, // 09:00 Tashkent
      kind,
      message.slice(0, 300),
      now(),
    );
  }
}

/** Everything due to be shown to this person now or earlier. */
export function dueReminders(userId: number): ReminderRow[] {
  return all<ReminderRow>(
    `SELECT r.*, a.description, a.deadline, p.name AS company_name
       FROM reminders r
       LEFT JOIN agreements a ON a.id = r.agreement_id
       LEFT JOIN partners p ON p.id = a.company_id
      WHERE r.user_id = ? AND r.status = 'PENDING' AND r.remind_at <= ?
      ORDER BY r.remind_at`,
    userId,
    now(),
  );
}

export function dismissReminder(id: number, userId: number): void {
  run(
    "UPDATE reminders SET status = 'DISMISSED', sent_at = ? WHERE id = ? AND user_id = ?",
    now(),
    id,
    userId,
  );
}

/* ------------------------------------------------------------------ */
/* Meetings, as the CRM sees them                                      */
/* ------------------------------------------------------------------ */

export interface MeetingRow {
  id: number;
  company_id: number | null;
  company_name: string | null;
  title: string;
  held_at: string | null;
  place: string | null;
  participants: string | null;
  responsible_id: number | null;
  responsible_name: string | null;
  description: string | null;
  next_steps: string | null;
  transcript: string;
  created_at: string;
  /** Storage key of the recording, when one was kept. */
  audio_key: string | null;
  duration: number | null;
  lang: string;
  summary: string | null;
  key_points: string | null;
  decisions: string | null;
}

export function meetingsOf(companyId: number, lang = "uz"): MeetingRow[] {
  return all<MeetingRow>(
    `SELECT m.*, p.name AS company_name, u.full_name AS responsible_name,
            c.summary, c.key_points, c.decisions
       FROM meetings m
       LEFT JOIN partners p ON p.id = m.company_id
       LEFT JOIN users u ON u.id = COALESCE(m.responsible_id, m.owner_id)
       LEFT JOIN meeting_conclusions c ON c.meeting_id = m.id AND c.lang = ?
      WHERE m.company_id = ?
      ORDER BY COALESCE(m.held_at, m.created_at) DESC`,
    lang,
    companyId,
  );
}

export function recentMeetings(lang = "uz", limit = 50): MeetingRow[] {
  return all<MeetingRow>(
    `SELECT m.*, p.name AS company_name, u.full_name AS responsible_name,
            c.summary, c.key_points, c.decisions
       FROM meetings m
       LEFT JOIN partners p ON p.id = m.company_id
       LEFT JOIN users u ON u.id = COALESCE(m.responsible_id, m.owner_id)
       LEFT JOIN meeting_conclusions c ON c.meeting_id = m.id AND c.lang = ?
      ORDER BY COALESCE(m.held_at, m.created_at) DESC LIMIT ?`,
    lang,
    limit,
  );
}

/* ------------------------------------------------------------------ */
/* Dashboard                                                           */
/* ------------------------------------------------------------------ */

export interface CrmTotals {
  companies: number;
  active: number;
  newThisMonth: number;
  meetingsThisMonth: number;
  openAgreements: number;
  dueToday: number;
  dueSoon: number;
  overdue: number;
}

export function crmTotals(): CrmTotals {
  const day = today();
  const monthStart = `${day.slice(0, 7)}-01`;
  const horizon = addDays(day, 7);
  const one = (sql: string, ...params: (string | number)[]) =>
    Number(get<{ n: number }>(sql, ...params)?.n ?? 0);

  return {
    companies: one("SELECT COUNT(*) AS n FROM partners"),
    active: one("SELECT COUNT(*) AS n FROM partners WHERE status = 'ACTIVE'"),
    newThisMonth: one(
      "SELECT COUNT(*) AS n FROM partners WHERE COALESCE(created_at, first_seen) >= ?",
      monthStart,
    ),
    meetingsThisMonth: one(
      "SELECT COUNT(*) AS n FROM meetings WHERE COALESCE(held_at, created_at) >= ?",
      monthStart,
    ),
    openAgreements: one(
      "SELECT COUNT(*) AS n FROM agreements WHERE status IN ('NEW','IN_PROGRESS')",
    ),
    dueToday: one(
      "SELECT COUNT(*) AS n FROM agreements WHERE status IN ('NEW','IN_PROGRESS') AND deadline = ?",
      day,
    ),
    dueSoon: one(
      `SELECT COUNT(*) AS n FROM agreements
        WHERE status IN ('NEW','IN_PROGRESS') AND deadline > ? AND deadline <= ?`,
      day,
      horizon,
    ),
    overdue: one(
      `SELECT COUNT(*) AS n FROM agreements
        WHERE status IN ('NEW','IN_PROGRESS') AND deadline IS NOT NULL AND deadline < ?`,
      day,
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Global search                                                       */
/* ------------------------------------------------------------------ */

export interface SearchHit {
  kind: "company" | "contact" | "meeting" | "agreement" | "task";
  id: number;
  title: string;
  subtitle: string;
  href: string;
}

/**
 * One query across everything a person might be holding in their head.
 *
 * Deliberately five small statements rather than one union: each carries its
 * own idea of what "matching" means, and the result is grouped by kind for the
 * reader anyway.
 */
export function search(query: string, limit = 6): SearchHit[] {
  const term = query.trim();
  if (term.length < 2) return [];
  const like = `%${term}%`;
  const hits: SearchHit[] = [];

  for (const row of all<{ id: number; name: string; industry: string | null; city: string | null }>(
    `SELECT id, name, industry, city FROM partners
      WHERE name LIKE ? COLLATE NOCASE OR industry LIKE ? COLLATE NOCASE
         OR services LIKE ? COLLATE NOCASE
      ORDER BY name LIMIT ?`,
    like, like, like, limit,
  )) {
    hits.push({
      kind: "company",
      id: row.id,
      title: row.name,
      subtitle: [row.industry, row.city].filter(Boolean).join(" · "),
      href: `/companies/${row.id}`,
    });
  }

  for (const row of all<{ id: number; company_id: number; first_name: string; last_name: string; position: string | null; company: string }>(
    `SELECT c.id, c.company_id, c.first_name, c.last_name, c.position, p.name AS company
       FROM contacts c JOIN partners p ON p.id = c.company_id
      WHERE c.first_name LIKE ? COLLATE NOCASE OR c.last_name LIKE ? COLLATE NOCASE
         OR c.email LIKE ? COLLATE NOCASE OR c.phone LIKE ?
      LIMIT ?`,
    like, like, like, like, limit,
  )) {
    hits.push({
      kind: "contact",
      id: row.id,
      title: `${row.first_name} ${row.last_name}`.trim(),
      subtitle: [row.position, row.company].filter(Boolean).join(" · "),
      href: `/companies/${row.company_id}`,
    });
  }

  for (const row of all<{ id: number; title: string; held_at: string | null; created_at: string; company: string | null }>(
    `SELECT m.id, m.title, m.held_at, m.created_at, p.name AS company
       FROM meetings m LEFT JOIN partners p ON p.id = m.company_id
      WHERE m.title LIKE ? COLLATE NOCASE OR m.transcript LIKE ? COLLATE NOCASE
      ORDER BY m.id DESC LIMIT ?`,
    like, like, limit,
  )) {
    hits.push({
      kind: "meeting",
      id: row.id,
      title: row.title,
      subtitle: [row.company, (row.held_at ?? row.created_at).slice(0, 10)]
        .filter(Boolean)
        .join(" · "),
      href: `/meetings/${row.id}`,
    });
  }

  for (const row of all<{ id: number; description: string; deadline: string | null; status: string; company: string | null; company_id: number | null }>(
    `SELECT a.id, a.description, a.deadline, a.status, a.company_id, p.name AS company
       FROM agreements a LEFT JOIN partners p ON p.id = a.company_id
      WHERE a.description LIKE ? COLLATE NOCASE
      ORDER BY a.id DESC LIMIT ?`,
    like, limit,
  )) {
    hits.push({
      kind: "agreement",
      id: row.id,
      title: row.description,
      subtitle: [row.company, row.deadline].filter(Boolean).join(" · "),
      href: row.company_id ? `/companies/${row.company_id}` : "/agreements",
    });
  }

  for (const row of all<{ id: number; code: string; title: string; status: string }>(
    `SELECT id, code, title, status FROM tasks
      WHERE title LIKE ? COLLATE NOCASE OR code LIKE ? COLLATE NOCASE
      ORDER BY id DESC LIMIT ?`,
    like, like, limit,
  )) {
    hits.push({
      kind: "task",
      id: row.id,
      title: row.title,
      subtitle: row.code,
      href: "/tasks/inbox",
    });
  }

  return hits;
}
