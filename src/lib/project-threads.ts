import { all, get, insert, now, run, tx } from "./pg";
import { today } from "./crm";
import { str } from "./validate";
import {
  entryKind,
  threadKind,
  type EntryKind,
  type ThreadKind,
} from "./project-vocab";

/**
 * Projects as workspaces, and the threads that hold their history.
 *
 * A project — Smart City, E-Class — is the thing the Assembly is doing. A
 * thread is one counterpart inside it: UNIDO, LG, the ministry, the internal
 * team. Opening `Smart City → UNIDO` has to rebuild months of dealings with
 * UNIDO from nothing, which is the whole requirement and the reason none of
 * this is built on `messages`.
 *
 * Three rules shape everything below.
 *
 * **An entry is dated by when it happened, not when it was typed.** Somebody
 * writes up Tuesday's meeting on Thursday; the journal must read Tuesday.
 * `occurred_on` carries that day and `created_at` records the typing, and the
 * reading order follows the former. A log that cannot do this is not a
 * history, it is an inbox.
 *
 * **The sidebar must not cost a query per thread.** A programme with forty
 * counterparts is normal, so `last_entry_at` is denormalised onto the thread
 * and written in the same transaction as the entry that moves it. The price
 * is one invariant maintained in code; the alternative is forty subqueries on
 * every page load.
 *
 * **A thread is a story, and the rows underneath it are the machinery.** An
 * entry can point at the meeting, the agreement or the task it produced, so
 * "they promised the documents by Friday" is at once a line in the narrative
 * and an agreement with a deadline that chases itself. Neither copy is the
 * truth on its own.
 */

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/**
 * Re-exported from `project-kinds`, which holds no database import.
 *
 * The split exists because the "new thread" form is a Client Component and
 * needs `THREAD_KINDS`; importing it from this module dragged the Postgres
 * driver into the browser bundle and broke the build. Server code keeps
 * importing everything from here, as it always did.
 */
export {
  THREAD_KINDS,
  ENTRY_KINDS,
  threadKind,
  entryKind,
  entryDay,
} from "./project-vocab";
export type { ThreadKind, EntryKind } from "./project-vocab";

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

export interface ProjectSummary {
  id: number;
  code: string;
  name: string;
  description: string | null;
  status: string;
  priority: string;
  stage: string | null;
  progress: number;
  deadline: string | null;
  started_at: string | null;
  owner_id: number | null;
  owner_full_name: string | null;
  thread_count: number;
  /** Most recent entry across every thread. Null until somebody writes one. */
  last_activity: string | null;
  /** Assignments in this project that nobody has accepted yet. */
  awaiting_acceptance: number;
  /** Assignments past their deadline and not finished. Derived, never stored. */
  overdue_tasks: number;
}

export interface ThreadRow {
  id: number;
  project_id: number;
  title: string;
  company_id: number | null;
  company_name: string | null;
  kind: ThreadKind;
  summary: string | null;
  is_archived: number;
  created_at: string;
  last_entry_at: string | null;
  entry_count: number;
}

export interface EntryRow {
  id: number;
  thread_id: number;
  author_id: number;
  author_full_name: string;
  kind: EntryKind;
  body: string;
  occurred_on: string | null;
  is_pinned: number;
  file_key: string | null;
  file_name: string | null;
  file_size: number | null;
  link_url: string | null;
  meeting_id: number | null;
  agreement_id: number | null;
  task_id: number | null;
  /** Filled when the entry raised a task, so the journal can show its state. */
  task_title: string | null;
  task_status: string | null;
  task_deadline: string | null;
  task_assignee: string | null;
  task_seen_at: string | null;
  task_accepted_at: string | null;
  /** Filled when the entry recorded an agreement. */
  agreement_text: string | null;
  agreement_status: string | null;
  agreement_deadline: string | null;
  edited_at: string | null;
  created_at: string;
}

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

const PROJECT_SELECT = `
  SELECT l.id, l.code, l.name, l.description, l.status, l.priority, l.stage,
         l.progress, l.deadline, l.started_at, l.owner_id,
         u.full_name AS owner_full_name,
         (SELECT COUNT(*) FROM project_threads pt
           WHERE pt.project_id = l.id AND pt.is_archived = 0) AS thread_count,
         (SELECT MAX(pt.last_entry_at) FROM project_threads pt
           WHERE pt.project_id = l.id) AS last_activity,
         -- The two numbers a manager scans the list for. Both are cheap
         -- against idx_tasks_project and both are the reason to open a row.
         (SELECT COUNT(*) FROM tasks tk
           WHERE tk.loyiha_id = l.id AND tk.status = 'YANGI') AS awaiting_acceptance,
         (SELECT COUNT(*) FROM tasks tk
           WHERE tk.loyiha_id = l.id AND tk.deadline IS NOT NULL
             AND tk.deadline < ?
             AND tk.status NOT IN ('BAJARILDI', 'RAD_ETILDI')) AS overdue_tasks
    FROM loyihalar l
    LEFT JOIN users u ON u.id = l.owner_id`;

/**
 * Every project, most recently touched first.
 *
 * `NULLS LAST` matters: a project created this morning with nothing written
 * in it yet has no activity at all, and without it Postgres would sort those
 * empty rows above everything anyone is actually working on.
 */
export async function projectList(): Promise<ProjectSummary[]> {
  return await all<ProjectSummary>(
    `${PROJECT_SELECT} ORDER BY last_activity DESC NULLS LAST, l.id DESC`,
    today(),
  );
}

export async function projectById(
  id: number,
): Promise<ProjectSummary | undefined> {
  return await get<ProjectSummary>(
    `${PROJECT_SELECT} WHERE l.id = ?`,
    today(),
    id,
  );
}

/* ------------------------------------------------------------------ */
/* Threads                                                             */
/* ------------------------------------------------------------------ */

const THREAD_SELECT = `
  SELECT t.id, t.project_id, t.title, t.company_id, p.name AS company_name,
         t.kind, t.summary, t.is_archived, t.created_at, t.last_entry_at,
         (SELECT COUNT(*) FROM thread_entries e WHERE e.thread_id = t.id) AS entry_count
    FROM project_threads t
    LEFT JOIN partners p ON p.id = t.company_id`;

/** The sidebar: live threads first, archived ones only when asked for. */
export async function threadsOf(
  projectId: number,
  includeArchived = false,
): Promise<ThreadRow[]> {
  const filter = includeArchived ? "" : " AND t.is_archived = 0";
  return await all<ThreadRow>(
    `${THREAD_SELECT} WHERE t.project_id = ?${filter}
      ORDER BY t.is_archived, t.last_entry_at DESC NULLS LAST, t.id`,
    projectId,
  );
}

export async function threadById(id: number): Promise<ThreadRow | undefined> {
  return await get<ThreadRow>(`${THREAD_SELECT} WHERE t.id = ?`, id);
}

export async function createThread(
  projectId: number,
  authorId: number,
  fields: {
    title: string;
    kind?: unknown;
    companyId?: number | null;
    summary?: string | null;
  },
): Promise<number> {
  return await insert(
    `INSERT INTO project_threads (project_id, title, company_id, kind, summary,
                                  created_by, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    projectId,
    fields.title,
    fields.companyId ?? null,
    threadKind(fields.kind),
    fields.summary ?? null,
    authorId,
    now(),
  );
}

export async function updateThread(
  threadId: number,
  fields: {
    title: string;
    kind?: unknown;
    companyId?: number | null;
    summary?: string | null;
  },
): Promise<void> {
  await run(
    `UPDATE project_threads
        SET title = ?, company_id = ?, kind = ?, summary = ?
      WHERE id = ?`,
    fields.title,
    fields.companyId ?? null,
    threadKind(fields.kind),
    fields.summary ?? null,
    threadId,
  );
}

/**
 * Archiving, not deleting.
 *
 * A finished counterpart is exactly the thread somebody will want to read in
 * two years — "what did we actually agree with them" — so the only supported
 * way out of the sidebar keeps every word of it.
 */
export async function archiveThread(
  threadId: number,
  archived: boolean,
): Promise<void> {
  await run(
    "UPDATE project_threads SET is_archived = ? WHERE id = ?",
    archived ? 1 : 0,
    threadId,
  );
}

/* ------------------------------------------------------------------ */
/* Entries                                                             */
/* ------------------------------------------------------------------ */

const ENTRY_SELECT = `
  SELECT e.id, e.thread_id, e.author_id, u.full_name AS author_full_name,
         e.kind, e.body, e.occurred_on, e.is_pinned,
         e.file_key, e.file_name, e.file_size, e.link_url,
         e.meeting_id, e.agreement_id, e.task_id,
         tk.title AS task_title, tk.status AS task_status,
         tk.deadline AS task_deadline, tu.full_name AS task_assignee,
         tk.seen_at AS task_seen_at, tk.accepted_at AS task_accepted_at,
         ag.description AS agreement_text, ag.status AS agreement_status,
         ag.deadline AS agreement_deadline,
         e.edited_at, e.created_at
    FROM thread_entries e
    JOIN users u ON u.id = e.author_id
    LEFT JOIN tasks tk ON tk.id = e.task_id
    LEFT JOIN users tu ON tu.id = tk.to_user_id
    LEFT JOIN agreements ag ON ag.id = e.agreement_id`;

/**
 * One thread's journal, oldest first — a history is read forwards.
 *
 * The window is taken from the END of the thread and then flipped, so a
 * thread with nine hundred entries opens on the recent ones rather than on
 * its first week. `beforeId` pages backwards into the past from there.
 */
export async function entriesOf(
  threadId: number,
  limit = 60,
  beforeId?: number,
): Promise<EntryRow[]> {
  const rows = beforeId
    ? await all<EntryRow>(
        `${ENTRY_SELECT} WHERE e.thread_id = ? AND e.id < ?
          ORDER BY e.id DESC LIMIT ?`,
        threadId,
        beforeId,
        limit,
      )
    : await all<EntryRow>(
        `${ENTRY_SELECT} WHERE e.thread_id = ? ORDER BY e.id DESC LIMIT ?`,
        threadId,
        limit,
      );
  return rows.reverse();
}

/** Entries somebody marked as worth finding again. Newest first. */
export async function pinnedOf(threadId: number): Promise<EntryRow[]> {
  return await all<EntryRow>(
    `${ENTRY_SELECT} WHERE e.thread_id = ? AND e.is_pinned = 1
      ORDER BY e.id DESC LIMIT 20`,
    threadId,
  );
}

export async function entryById(id: number): Promise<EntryRow | undefined> {
  return await get<EntryRow>(`${ENTRY_SELECT} WHERE e.id = ?`, id);
}

export interface NewEntry {
  kind?: unknown;
  body?: unknown;
  occurredOn?: unknown;
  fileKey?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  linkUrl?: string | null;
  meetingId?: number | null;
  agreementId?: number | null;
  taskId?: number | null;
}

/**
 * Appends an entry and moves the thread's activity marker in one transaction.
 *
 * The two writes are inseparable: an entry whose thread still claims it was
 * last touched in March sinks to the bottom of a sidebar ordered by activity,
 * which is the one place anybody would look for it.
 */
export async function addEntry(
  threadId: number,
  authorId: number,
  fields: NewEntry,
): Promise<number> {
  const stamp = now();
  // A day the writer supplied wins; otherwise the entry is dated by the day
  // it was written, which the reader sees identically.
  const occurred = str(fields.occurredOn, 10);

  return await tx(async (q) => {
    const id = await q.insert(
      `INSERT INTO thread_entries (thread_id, author_id, kind, body, occurred_on,
                                   file_key, file_name, file_size, link_url,
                                   meeting_id, agreement_id, task_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      threadId,
      authorId,
      entryKind(fields.kind),
      str(fields.body, 8000) ?? "",
      occurred,
      fields.fileKey ?? null,
      fields.fileName ?? null,
      fields.fileSize ?? null,
      fields.linkUrl ?? null,
      fields.meetingId ?? null,
      fields.agreementId ?? null,
      fields.taskId ?? null,
      stamp,
    );

    // GREATEST, not a plain assignment: writing up a meeting from three weeks
    // ago must not drag the thread backwards past everything newer.
    await q.run(
      `UPDATE project_threads
          SET last_entry_at = GREATEST(COALESCE(last_entry_at, ?), ?)
        WHERE id = ?`,
      stamp,
      stamp,
      threadId,
    );
    return id;
  });
}

export async function editEntry(
  entryId: number,
  body: string,
  occurredOn: string | null,
): Promise<void> {
  await run(
    "UPDATE thread_entries SET body = ?, occurred_on = ?, edited_at = ? WHERE id = ?",
    body,
    occurredOn,
    now(),
    entryId,
  );
}

export async function pinEntry(
  entryId: number,
  pinned: boolean,
): Promise<void> {
  await run(
    "UPDATE thread_entries SET is_pinned = ? WHERE id = ?",
    pinned ? 1 : 0,
    entryId,
  );
}

/**
 * Removes an entry, leaving whatever it produced alone.
 *
 * Deleting the sentence "they promised the documents by Friday" must not
 * delete the agreement that is chasing Friday. The columns are references,
 * not ownership.
 */
export async function deleteEntry(entryId: number): Promise<void> {
  await run("DELETE FROM thread_entries WHERE id = ?", entryId);
}

/* ------------------------------------------------------------------ */
/* Thread membership                                                   */
/* ------------------------------------------------------------------ */

export interface ThreadMember {
  user_id: number;
  full_name: string;
  position: string | null;
}

export async function threadMembers(threadId: number): Promise<ThreadMember[]> {
  return await all<ThreadMember>(
    `SELECT m.user_id, u.full_name, u.position
       FROM thread_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.thread_id = ?
      ORDER BY u.full_name`,
    threadId,
  );
}

export async function addThreadMember(
  threadId: number,
  userId: number,
): Promise<void> {
  // Adding somebody twice is a double click, not an error worth a 409.
  await run(
    `INSERT INTO thread_members (thread_id, user_id, created_at) VALUES (?,?,?)
       ON CONFLICT (thread_id, user_id) DO NOTHING`,
    threadId,
    userId,
    now(),
  );
}

export async function removeThreadMember(
  threadId: number,
  userId: number,
): Promise<void> {
  await run(
    "DELETE FROM thread_members WHERE thread_id = ? AND user_id = ?",
    threadId,
    userId,
  );
}

/* ------------------------------------------------------------------ */
/* What is happening right now                                         */
/* ------------------------------------------------------------------ */

export interface ProjectPulse {
  /** Tasks raised in this project, by the state their manager cares about. */
  tasks: {
    overdue: number;
    awaitingAcceptance: number;
    inProgress: number;
    done: number;
  };
  /** Assignments nobody has accepted yet — the point of the whole block. */
  waiting: {
    id: number;
    title: string;
    assignee: string;
    created_at: string;
    seen_at: string | null;
    deadline: string | null;
  }[];
  /** Agreements still open, soonest deadline first. */
  openAgreements: {
    id: number;
    description: string;
    deadline: string | null;
    status: string;
    company_name: string | null;
  }[];
}

/**
 * The project's state of play, in the three numbers and two lists a person
 * opening it actually needs.
 *
 * "Overdue" is derived here rather than stored, the same rule the CRM already
 * follows: a stored flag is wrong between midnight and whenever a job fixes
 * it, and there is no job to schedule if nothing is stored.
 */
export async function projectPulse(projectId: number): Promise<ProjectPulse> {
  const day = today();

  const counts = await get<{
    overdue: string;
    awaiting: string;
    in_progress: string;
    done: string;
  }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE deadline IS NOT NULL AND deadline < ?
           AND status NOT IN ('BAJARILDI', 'RAD_ETILDI')) AS overdue,
       COUNT(*) FILTER (WHERE status = 'YANGI')            AS awaiting,
       COUNT(*) FILTER (
         WHERE status IN ('QABUL_QILINDI', 'BAJARILMOQDA',
                          'TEKSHIRUVDA', 'QAYTARILDI'))    AS in_progress,
       COUNT(*) FILTER (WHERE status = 'BAJARILDI')        AS done
     FROM tasks WHERE loyiha_id = ?`,
    day,
    projectId,
  );

  const waiting = await all<ProjectPulse["waiting"][number]>(
    `SELECT t.id, t.title, u.full_name AS assignee, t.created_at,
            t.seen_at, t.deadline
       FROM tasks t
       JOIN users u ON u.id = t.to_user_id
      WHERE t.loyiha_id = ? AND t.status = 'YANGI'
      ORDER BY t.created_at
      LIMIT 8`,
    projectId,
  );

  const openAgreements = await all<ProjectPulse["openAgreements"][number]>(
    `SELECT a.id, a.description, a.deadline, a.status, p.name AS company_name
       FROM agreements a
       LEFT JOIN partners p ON p.id = a.company_id
      WHERE a.loyiha_id = ? AND a.status IN ('NEW', 'IN_PROGRESS')
      ORDER BY a.deadline NULLS LAST, a.id DESC
      LIMIT 8`,
    projectId,
  );

  return {
    tasks: {
      overdue: Number(counts?.overdue ?? 0),
      awaitingAcceptance: Number(counts?.awaiting ?? 0),
      inProgress: Number(counts?.in_progress ?? 0),
      done: Number(counts?.done ?? 0),
    },
    waiting,
    openAgreements,
  };
}

/* ------------------------------------------------------------------ */
/* Creating a project                                                  */
/* ------------------------------------------------------------------ */

/**
 * A short code derived from the name, because the column requires one and the
 * person opening "Smart City" should not have to invent `SC-2026` first.
 *
 * `loyihalar.code` predates this screen: it appears in task references and on
 * the public site, so it cannot simply be dropped. Deriving it keeps both
 * true — the register still has its code, and nobody is asked for a field
 * that means nothing to the work they are actually starting.
 */
export function deriveCode(name: string): string {
  const base = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 12);
  // A name written entirely in Cyrillic leaves nothing behind; a stable
  // prefix plus the clock beats an empty string that would collide at once.
  return base || `PRJ-${Date.now().toString(36).toUpperCase().slice(-6)}`;
}

export interface ProjectFieldsInput {
  name: string;
  description: string | null;
  status: string;
  priority: string;
  stage: string | null;
  deadline: string | null;
  startedAt: string | null;
  ownerId: number | null;
}

/**
 * Creates the project, giving it a code nobody else holds.
 *
 * The suffix loop is bounded rather than open: past a handful of collisions
 * the names are so alike that a number no longer distinguishes them, and the
 * timestamp fallback is both unique and obviously machine-made.
 */
export async function createProject(
  fields: ProjectFieldsInput,
): Promise<number> {
  const base = deriveCode(fields.name);
  let code = base;
  for (let attempt = 2; attempt <= 9; attempt++) {
    const taken = await get<{ id: number }>(
      "SELECT id FROM loyihalar WHERE lower(code) = lower(?)",
      code,
    );
    if (!taken) break;
    code =
      attempt === 9
        ? `${base.slice(0, 8)}-${Date.now().toString(36).slice(-4).toUpperCase()}`
        : `${base.slice(0, 13)}-${attempt}`;
  }

  return await insert(
    `INSERT INTO loyihalar (code, name, description, status, priority, stage,
                            deadline, started_at, owner_id, progress, budget, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,0,0,?)`,
    code,
    fields.name,
    fields.description,
    fields.status,
    fields.priority,
    fields.stage,
    fields.deadline,
    fields.startedAt,
    fields.ownerId,
    now(),
  );
}

export async function updateProject(
  id: number,
  fields: ProjectFieldsInput,
): Promise<void> {
  await run(
    `UPDATE loyihalar
        SET name = ?, description = ?, status = ?, priority = ?, stage = ?,
            deadline = ?, started_at = ?, owner_id = ?
      WHERE id = ?`,
    fields.name,
    fields.description,
    fields.status,
    fields.priority,
    fields.stage,
    fields.deadline,
    fields.startedAt,
    fields.ownerId,
    id,
  );
}
