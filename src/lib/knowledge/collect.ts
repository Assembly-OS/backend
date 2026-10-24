import { mimeForKey, readAttachment } from "../agents/read-file";
import { readForKnowledge } from "../agents/read-knowledge";
import { transcribeAudio, transcriptionAvailable } from "../agents/transcribe";
import { all, get, now, run } from "../pg";
import { storeFileText } from "../project-threads";
import { read, resolvePath } from "../uploads";
import { RELIABILITY, type SourceKind } from "./text";
import type { SourceReason } from "./types";

/**
 * Reading one original record into words.
 *
 * Each collector opens the record the way its own page does and renders it
 * as plain text a reader could check against the page: the fields in the
 * order the form shows them, then the history, then the document's or the
 * recording's words. Dates are written out so a passage carries its own
 * "when", and names are written out so a passage carries its own "who" —
 * a passage is read on its own later, far from the row it came from.
 *
 * A collector returns `null` when the record no longer exists; the pipeline
 * retires the source. It returns `skip` when there is nothing worth reading
 * (a two-word chat line), and `partial` with a reason when part of the
 * record could not be read — an attachment that would not open, a voice
 * note with no transcription available — so the memory says what it is
 * missing rather than pretending the record was shorter.
 */

export interface Collected {
  title: string;
  text: string;
  /** When the thing happened, 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS' UTC. */
  occurredAt: string | null;
  authorId: number | null;
  lang: string | null;
  reliability: number;
  scope: {
    projectId?: number | null;
    companyId?: number | null;
    meetingId?: number | null;
    taskId?: number | null;
    threadId?: number | null;
    groupId?: number | null;
    fromUserId?: number | null;
    toUserId?: number | null;
    uyushmaId?: number | null;
  };
  links: { toKind: "project" | "person" | "task" | "company" | "meeting"; toId: number; relation: string }[];
  partial?: boolean;
  reason?: SourceReason | null;
  /** Set when the record is real but has nothing to index. */
  skip?: SourceReason;
  /** Facts the record states outright, needing no model to read them. */
  facts?: DerivedFact[];
}

export interface DerivedFact {
  kind: "decision" | "commitment" | "action_item" | "deadline" | "fact" | "risk";
  subject: string | null;
  statement: string;
  who: string | null;
  whoUserId: number | null;
  dueOn: string | null;
  taskId?: number | null;
}

/** A line of the rendering, skipped when the value is empty. */
function line(label: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  return `${label}: ${String(value).trim()}\n`;
}

function day(value: string | null | undefined): string | null {
  return value ? value.slice(0, 10) : null;
}

/** A stored file's words, by the two readers the platform already has. */
async function fileWords(
  key: string | null,
  name: string | null,
  options: { full: boolean; mime?: string | null },
): Promise<{ text: string | null; reason: SourceReason | null; partial: boolean }> {
  if (!key) return { text: null, reason: null, partial: false };
  const mime = options.mime ?? mimeForKey(key);
  if (!mime) return { text: null, reason: "UNSUPPORTED", partial: false };
  const bytes = read(key);
  if (!bytes) return { text: null, reason: "GONE", partial: false };
  if (options.full) {
    const outcome = await readForKnowledge(bytes, mime, name ?? "file");
    if (!outcome.ok) return { text: null, reason: outcome.reason, partial: false };
    return { text: outcome.text, reason: outcome.partial ? "TOO_LONG" : null, partial: outcome.partial };
  }
  const text = await readAttachment(bytes, mime, name ?? "file");
  return { text, reason: text ? null : "FILE_UNREAD", partial: false };
}

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

const EVENT_WORDS: Record<string, string> = {
  YARATILDI: "created",
  QABUL_QILINDI: "accepted",
  BAJARILMOQDA: "started",
  TEKSHIRUVDA: "submitted for review",
  BAJARILDI: "approved as done",
  QAYTARILDI: "returned for rework",
  RAD_ETILDI: "declined",
  BOSQICH_BOSHLANDI: "next stage opened",
};

async function collectTask(id: number): Promise<Collected | null> {
  const task = await get<Record<string, unknown>>(
    `SELECT t.*, f.full_name AS from_name, u.full_name AS to_name, r.full_name AS reviewer_name,
            l.code AS project_code, l.name AS project_name, y.name AS uyushma_name
       FROM tasks t
       JOIN users f ON f.id = t.from_user_id
       JOIN users u ON u.id = t.to_user_id
       LEFT JOIN users r ON r.id = t.reviewer_user_id
       LEFT JOIN loyihalar l ON l.id = t.loyiha_id
       LEFT JOIN uyushmalar y ON y.id = t.uyushma_id
      WHERE t.id = ?`,
    id,
  );
  if (!task) return null;

  const stages = await all<Record<string, unknown>>(
    `SELECT s.position, s.status, s.instruction, s.result_comment, s.closed_at,
            u.full_name AS holder, r.full_name AS reviewer
       FROM task_stages s JOIN users u ON u.id = s.to_user_id
       LEFT JOIN users r ON r.id = s.reviewer_user_id
      WHERE s.task_id = ? ORDER BY s.position`,
    id,
  );
  const events = await all<Record<string, unknown>>(
    `SELECT e.action, e.comment, e.created_at, u.full_name AS actor
       FROM task_events e JOIN users u ON u.id = e.user_id
      WHERE e.task_id = ? ORDER BY e.id`,
    id,
  );
  const progress = await all<Record<string, unknown>>(
    `SELECT p.did, p.outcome, p.metric, p.blocker, p.help_needed, p.created_at,
            u.full_name AS author
       FROM task_progress p JOIN users u ON u.id = p.author_id
      WHERE p.task_id = ? ORDER BY p.id`,
    id,
  );

  const code = String(task.code);
  const title = String(task.title);
  let text =
    `Task ${code}: ${title}\n` +
    line("Status", task.status) +
    line("Priority", task.priority) +
    line("Kind", task.kind === "MUDDATSIZ" ? "open-ended" : "deadline-bound") +
    line("Assigned by", task.from_name) +
    line("Responsible", task.to_name) +
    line("Reviewer", task.reviewer_name) +
    line("Department", task.to_department) +
    line("Deadline", task.deadline) +
    line("Project", task.project_code ? `${task.project_code} ${task.project_name}` : null) +
    line("Association", task.uyushma_name) +
    line("Created", day(task.created_at as string)) +
    line("Accepted", day(task.accepted_at as string | null)) +
    line("Submitted", day(task.submitted_at as string | null)) +
    line("Closed", day(task.closed_at as string | null)) +
    line("Target", task.target_value ? `${task.target_value} ${task.target_unit ?? ""}` : null) +
    line("Description", task.description) +
    line("Result", task.result_comment);

  if (stages.length > 1) {
    text += "\nChain:\n";
    for (const stage of stages)
      text +=
        `- Stage ${stage.position}: ${stage.holder}` +
        (stage.reviewer ? ` (reviewed by ${stage.reviewer})` : "") +
        ` — ${stage.status}` +
        (stage.instruction ? `: ${stage.instruction}` : "") +
        (stage.result_comment ? `. Result: ${stage.result_comment}` : "") +
        "\n";
  }
  if (events.length > 0) {
    text += "\nHistory:\n";
    for (const event of events)
      text +=
        `- ${day(event.created_at as string)} ${event.actor}: ${EVENT_WORDS[String(event.action)] ?? event.action}` +
        (event.comment ? ` — ${event.comment}` : "") +
        "\n";
  }
  if (progress.length > 0) {
    text += "\nProgress journal:\n";
    for (const entry of progress)
      text +=
        `- ${day(entry.created_at as string)} ${entry.author}: did ${entry.did}; outcome ${entry.outcome}` +
        (entry.metric !== null && entry.metric !== undefined ? `; figure ${entry.metric}` : "") +
        (entry.blocker ? `; blocker: ${entry.blocker}` : "") +
        (entry.help_needed ? `; help needed: ${entry.help_needed}` : "") +
        "\n";
  }

  let partial = false;
  let reason: SourceReason | null = null;
  if (task.result_file_key) {
    const file = await fileWords(
      task.result_file_key as string,
      task.result_file_name as string,
      { full: false },
    );
    if (file.text) text += `\nResult file "${task.result_file_name}":\n${file.text}\n`;
    else {
      text += `\nResult file "${task.result_file_name}" — not read.\n`;
      partial = true;
      reason = file.reason;
    }
  }

  const open = !["BAJARILDI", "RAD_ETILDI"].includes(String(task.status));
  const facts: DerivedFact[] = [
    {
      kind: "action_item",
      subject: title,
      statement: `${task.to_name} is responsible for "${title}" (${code}), assigned by ${task.from_name}; status ${task.status}${task.deadline ? `, due ${task.deadline}` : ""}.`,
      who: String(task.to_name),
      whoUserId: Number(task.to_user_id),
      dueOn: (task.deadline as string | null) ?? null,
      taskId: id,
    },
  ];
  if (task.deadline && open)
    facts.push({
      kind: "deadline",
      subject: title,
      statement: `"${title}" (${code}) is due on ${task.deadline}.`,
      who: String(task.to_name),
      whoUserId: Number(task.to_user_id),
      dueOn: task.deadline as string,
      taskId: id,
    });

  return {
    title: `${code} · ${title}`,
    text,
    occurredAt: task.created_at as string,
    authorId: Number(task.from_user_id),
    lang: null,
    reliability: RELIABILITY.task,
    scope: {
      projectId: (task.loyiha_id as number | null) ?? null,
      taskId: id,
      fromUserId: Number(task.from_user_id),
      toUserId: Number(task.to_user_id),
      uyushmaId: (task.uyushma_id as number | null) ?? null,
    },
    links: [
      { toKind: "person", toId: Number(task.to_user_id), relation: "assigned" },
      { toKind: "person", toId: Number(task.from_user_id), relation: "mentions" },
      ...(task.loyiha_id ? [{ toKind: "project" as const, toId: Number(task.loyiha_id), relation: "about" }] : []),
    ],
    partial,
    reason,
    facts,
  };
}

/* ------------------------------------------------------------------ */
/* Meetings                                                            */
/* ------------------------------------------------------------------ */

function list(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Transcripts past this are kept in part: a two-hour meeting is enough. */
const MAX_TRANSCRIPT = 400_000;

async function collectMeeting(id: number): Promise<Collected | null> {
  const meeting = await get<Record<string, unknown>>(
    `SELECT m.*, o.full_name AS owner_name, r.full_name AS responsible_name,
            p.name AS company_name, y.name AS uyushma_name,
            t.code AS next_task_code, t.title AS next_task_title
       FROM meetings m
       JOIN users o ON o.id = m.owner_id
       LEFT JOIN users r ON r.id = m.responsible_id
       LEFT JOIN partners p ON p.id = m.company_id
       LEFT JOIN uyushmalar y ON y.id = m.uyushma_id
       LEFT JOIN tasks t ON t.id = m.next_task_id
      WHERE m.id = ?`,
    id,
  );
  if (!meeting) return null;

  const conclusion = await get<{ summary: string; key_points: string; decisions: string }>(
    `SELECT summary, key_points, decisions FROM meeting_conclusions
      WHERE meeting_id = ? ORDER BY CASE lang WHEN 'uz' THEN 0 WHEN 'ru' THEN 1 ELSE 2 END LIMIT 1`,
    id,
  );
  const memory = await all<{ subject: string; fact: string; kind: string }>(
    "SELECT subject, fact, kind FROM meeting_memory WHERE meeting_id = ? ORDER BY id",
    id,
  );
  const projects = await all<{ id: number; code: string; name: string }>(
    `SELECT l.id, l.code, l.name FROM meeting_projects mp JOIN loyihalar l ON l.id = mp.project_id
      WHERE mp.meeting_id = ? ORDER BY l.code`,
    id,
  );
  const staff = await all<{ id: number; full_name: string }>(
    `SELECT u.id, u.full_name FROM meeting_staff ms JOIN users u ON u.id = ms.user_id
      WHERE ms.meeting_id = ? ORDER BY u.full_name`,
    id,
  );
  const agreements = await all<{ description: string; deadline: string | null; status: string; owner: string | null }>(
    `SELECT a.description, a.deadline, a.status, COALESCE(u.full_name, a.owner_name) AS owner
       FROM agreements a LEFT JOIN users u ON u.id = a.owner_user_id
      WHERE a.meeting_id = ? ORDER BY a.id`,
    id,
  );

  const held = day((meeting.held_at as string | null) ?? (meeting.created_at as string));
  const title = String(meeting.title);
  let text =
    `Meeting: ${title}\n` +
    line("Date", held) +
    line("Company", meeting.company_name) +
    line("Association", meeting.uyushma_name) +
    line("Place", meeting.place) +
    line("Participants", meeting.participants) +
    line("Assembly staff present", staff.map((person) => person.full_name).join(", ") || null) +
    line("Projects", projects.map((project) => `${project.code} ${project.name}`).join("; ") || null) +
    line("Filed by", meeting.owner_name) +
    line("Responsible for the next step", meeting.responsible_name) +
    line("Legal status", meeting.legal_status) +
    line("What was discussed", meeting.description) +
    line("What was agreed", meeting.agreed) +
    line("Open issues", meeting.open_issues) +
    line("Next steps", meeting.next_steps) +
    line("Next step as a task", meeting.next_task_code ? `${meeting.next_task_code} ${meeting.next_task_title}` : null);

  if (conclusion) {
    text += `\nAI summary (reviewed by nobody unless the fields above say the same):\n${conclusion.summary}\n`;
    const points = list(conclusion.key_points);
    const decisions = list(conclusion.decisions);
    if (points.length) text += `Key points:\n${points.map((point) => `- ${point}`).join("\n")}\n`;
    if (decisions.length) text += `Decisions:\n${decisions.map((item) => `- ${item}`).join("\n")}\n`;
  }
  if (memory.length) {
    text += "\nNoted from the meeting:\n";
    for (const item of memory) text += `- [${item.kind}] ${item.subject}: ${item.fact}\n`;
  }
  if (agreements.length) {
    text += "\nCommitments recorded from this meeting:\n";
    for (const item of agreements)
      text += `- ${item.description} — ${item.owner ?? "owner not set"}${item.deadline ? `, by ${item.deadline}` : ""} (${item.status})\n`;
  }

  const transcript = String(meeting.transcript ?? "").trim();
  let partial = false;
  if (transcript) {
    text += `\nTranscript:\n${transcript.slice(0, MAX_TRANSCRIPT)}\n`;
    partial = transcript.length > MAX_TRANSCRIPT;
  }

  const facts: DerivedFact[] = [];
  if (meeting.agreed)
    facts.push({
      kind: "decision",
      subject: title,
      statement: String(meeting.agreed),
      who: (meeting.responsible_name as string | null) ?? null,
      whoUserId: (meeting.responsible_id as number | null) ?? null,
      dueOn: null,
    });
  for (const item of agreements)
    facts.push({
      kind: "commitment",
      subject: title,
      statement: item.description,
      who: item.owner,
      whoUserId: null,
      dueOn: item.deadline,
    });

  return {
    title: `${held ?? ""} ${title}`.trim(),
    text,
    occurredAt: held,
    authorId: Number(meeting.owner_id),
    lang: typeof meeting.lang === "string" ? meeting.lang.slice(0, 2) : null,
    reliability: RELIABILITY.meeting,
    scope: {
      projectId: projects[0]?.id ?? null,
      companyId: (meeting.company_id as number | null) ?? null,
      meetingId: id,
      uyushmaId: (meeting.uyushma_id as number | null) ?? null,
    },
    links: [
      ...projects.map((project) => ({ toKind: "project" as const, toId: project.id, relation: "about" })),
      ...staff.map((person) => ({ toKind: "person" as const, toId: person.id, relation: "mentions" })),
      ...(meeting.company_id ? [{ toKind: "company" as const, toId: Number(meeting.company_id), relation: "about" }] : []),
    ],
    partial,
    reason: partial ? "TOO_LONG" : null,
    facts,
  };
}

/* ------------------------------------------------------------------ */
/* Project journal                                                     */
/* ------------------------------------------------------------------ */

async function collectEntry(id: number): Promise<Collected | null> {
  const entry = await get<Record<string, unknown>>(
    `SELECT e.*, u.full_name AS author_name, th.title AS thread_title, th.project_id,
            l.code AS project_code, l.name AS project_name, p.name AS company_name,
            th.company_id
       FROM thread_entries e
       JOIN project_threads th ON th.id = e.thread_id
       JOIN loyihalar l ON l.id = th.project_id
       JOIN users u ON u.id = e.author_id
       LEFT JOIN partners p ON p.id = th.company_id
      WHERE e.id = ?`,
    id,
  );
  if (!entry) return null;

  const when = day((entry.occurred_on as string | null) ?? (entry.created_at as string));
  let fileText = (entry.file_text as string | null) ?? null;
  let partial = false;
  let reason: SourceReason | null = null;
  if (entry.file_key && !fileText) {
    const file = await fileWords(entry.file_key as string, entry.file_name as string, { full: false });
    if (file.text) {
      fileText = file.text;
      // The project's own memory reads this column; keep the two in step.
      await storeFileText(id, file.text);
    } else {
      partial = true;
      reason = file.reason;
    }
  }

  const body = String(entry.body ?? "").trim();
  if (!body && !fileText && !entry.link_url)
    return {
      title: String(entry.thread_title),
      text: "",
      occurredAt: when,
      authorId: Number(entry.author_id),
      lang: null,
      reliability: RELIABILITY.thread_entry,
      scope: { projectId: Number(entry.project_id), threadId: Number(entry.thread_id) },
      links: [],
      skip: partial ? (reason ?? "FILE_UNREAD") : "EMPTY",
    };

  let text =
    `Project journal — ${entry.project_code} ${entry.project_name}, thread "${entry.thread_title}"` +
    (entry.company_name ? ` (${entry.company_name})` : "") +
    `\n` +
    line("Date", when) +
    line("Written by", entry.author_name) +
    line("Kind", entry.kind) +
    (body ? `\n${body}\n` : "") +
    line("Link", entry.link_url);
  if (entry.file_name) {
    text += fileText
      ? `\nAttached document "${entry.file_name}":\n${fileText}\n`
      : `\nAttached document "${entry.file_name}" — not read, contents unknown.\n`;
  }

  return {
    title: `${entry.thread_title}: ${(body || String(entry.file_name ?? entry.link_url ?? "")).slice(0, 80)}`,
    text,
    occurredAt: when,
    authorId: Number(entry.author_id),
    lang: null,
    reliability: RELIABILITY.thread_entry,
    scope: {
      projectId: Number(entry.project_id),
      threadId: Number(entry.thread_id),
      companyId: (entry.company_id as number | null) ?? null,
      meetingId: (entry.meeting_id as number | null) ?? null,
      taskId: (entry.task_id as number | null) ?? null,
    },
    links: [
      { toKind: "project", toId: Number(entry.project_id), relation: "about" },
      { toKind: "person", toId: Number(entry.author_id), relation: "mentions" },
      ...(entry.task_id ? [{ toKind: "task" as const, toId: Number(entry.task_id), relation: "produced" }] : []),
      ...(entry.meeting_id ? [{ toKind: "meeting" as const, toId: Number(entry.meeting_id), relation: "produced" }] : []),
    ],
    partial,
    reason,
  };
}

/* ------------------------------------------------------------------ */
/* Chat                                                                */
/* ------------------------------------------------------------------ */

/** A text message shorter than this is not a record of anything. */
const MIN_MESSAGE = 12;

async function collectMessage(id: number): Promise<Collected | null> {
  const message = await get<Record<string, unknown>>(
    `SELECT m.*, f.full_name AS from_name, t.full_name AS to_name, g.title AS group_title
       FROM messages m
       JOIN users f ON f.id = m.from_user_id
       LEFT JOIN users t ON t.id = m.to_user_id
       LEFT JOIN chat_groups g ON g.id = m.group_id
      WHERE m.id = ?`,
    id,
  );
  if (!message) return null;

  const base = {
    occurredAt: message.created_at as string,
    authorId: Number(message.from_user_id),
    lang: null,
    reliability: RELIABILITY.message,
    scope: {
      fromUserId: Number(message.from_user_id),
      toUserId: (message.to_user_id as number | null) ?? null,
      groupId: (message.group_id as number | null) ?? null,
    },
    links: [{ toKind: "person" as const, toId: Number(message.from_user_id), relation: "mentions" }],
  };
  const where = message.group_title
    ? `group chat "${message.group_title}"`
    : `chat between ${message.from_name} and ${message.to_name}`;
  const head =
    `Chat message in ${where}\n` +
    line("From", message.from_name) +
    line("Sent", day(message.created_at as string));
  const body = String(message.body ?? "").trim();
  const kind = String(message.kind ?? "text");

  if (kind === "text") {
    if (body.length < MIN_MESSAGE)
      return { ...base, title: body.slice(0, 60), text: "", skip: "SHORT" };
    return { ...base, title: `${message.from_name}: ${body.slice(0, 70)}`, text: `${head}\n${body}\n` };
  }

  if (kind === "voice") {
    let transcript = (message.transcript as string | null)?.trim() ?? "";
    let reason: SourceReason | null = null;
    if (!transcript) {
      const path = message.file_key ? resolvePath(message.file_key as string) : null;
      if (!path) reason = "GONE";
      else if (!transcriptionAvailable()) reason = "STT_UNAVAILABLE";
      else {
        const result = await transcribeAudio(path, "auto");
        if (typeof result === "string") reason = result === "UNAVAILABLE" ? "STT_UNAVAILABLE" : result;
        else {
          transcript = result.text;
          await run("UPDATE messages SET transcript = ? WHERE id = ?", transcript, id);
        }
      }
    }
    const title = `${message.from_name}: voice note${transcript ? ` — ${transcript.slice(0, 60)}` : ""}`;
    if (!transcript)
      return {
        ...base,
        title,
        text: `${head}Voice message${body ? ` with caption: ${body}` : ""} — not transcribed.\n`,
        partial: true,
        reason,
        // A failed transcription is a failure to retry, not a record to index.
        skip: reason ?? "EMPTY",
      };
    return {
      ...base,
      title,
      text: `${head}${line("Caption", body)}\nVoice message, transcribed:\n${transcript}\n`,
    };
  }

  // A photo or a file.
  const file = await fileWords(message.file_key as string | null, message.file_name as string | null, {
    full: false,
    mime: (message.file_mime as string | null) ?? null,
  });
  const name = String(message.file_name ?? "file");
  if (!file.text && !body)
    return { ...base, title: `${message.from_name}: ${name}`, text: "", skip: file.reason ?? "FILE_UNREAD" };
  return {
    ...base,
    title: `${message.from_name}: ${name}`,
    text:
      `${head}${line("Caption", body)}` +
      (file.text ? `\nAttached "${name}":\n${file.text}\n` : `\nAttached "${name}" — not read.\n`),
    partial: !file.text,
    reason: file.text ? null : file.reason,
  };
}

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

async function collectProjectDocument(id: number): Promise<Collected | null> {
  const doc = await get<Record<string, unknown>>(
    `SELECT d.*, l.code AS project_code, l.name AS project_name, u.full_name AS uploader_name
       FROM project_documents d JOIN loyihalar l ON l.id = d.loyiha_id
       LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.id = ?`,
    id,
  );
  if (!doc) return null;
  const file = await fileWords(doc.file_key as string, doc.file_name as string, { full: true });
  const head =
    `Project document — ${doc.project_code} ${doc.project_name}\n` +
    line("Title", doc.title) +
    line("Kind", doc.kind) +
    line("File", doc.file_name) +
    line("Added by", doc.uploader_name) +
    line("Added", day(doc.created_at as string));
  return {
    title: `${doc.project_code} · ${doc.title}`,
    text: file.text ? `${head}\n${file.text}\n` : `${head}\nThe file could not be read.\n`,
    occurredAt: day(doc.created_at as string),
    authorId: (doc.uploaded_by as number | null) ?? null,
    lang: null,
    reliability: RELIABILITY.project_document,
    scope: { projectId: Number(doc.loyiha_id) },
    links: [{ toKind: "project", toId: Number(doc.loyiha_id), relation: "attached" }],
    partial: !file.text || file.partial,
    reason: file.reason,
    skip: file.text ? undefined : (file.reason ?? "FILE_UNREAD"),
  };
}

async function collectLibrary(id: number): Promise<Collected | null> {
  const doc = await get<Record<string, unknown>>(
    `SELECT d.*, u.full_name AS uploader_name, l.code AS project_code, l.name AS project_name
       FROM knowledge_documents d JOIN users u ON u.id = d.uploaded_by
       LEFT JOIN loyihalar l ON l.id = d.project_id
      WHERE d.id = ?`,
    id,
  );
  if (!doc) return null;
  const file = await fileWords(doc.file_key as string, doc.file_name as string, {
    full: true,
    mime: doc.file_mime as string,
  });
  const head =
    `Library document: ${doc.title}\n` +
    line("File", doc.file_name) +
    line("Format", doc.format) +
    line("Project", doc.project_code ? `${doc.project_code} ${doc.project_name}` : null) +
    line("Added by", doc.uploader_name) +
    line("Added", day(doc.updated_at as string));
  return {
    title: String(doc.title),
    text: file.text ? `${head}\n${file.text}\n` : `${head}\nThe file could not be read.\n`,
    occurredAt: day(doc.updated_at as string),
    authorId: Number(doc.uploaded_by),
    lang: null,
    reliability: RELIABILITY.library,
    scope: { projectId: (doc.project_id as number | null) ?? null },
    links: doc.project_id ? [{ toKind: "project", toId: Number(doc.project_id), relation: "attached" }] : [],
    partial: !file.text || file.partial,
    reason: file.reason,
    skip: file.text ? undefined : (file.reason ?? "FILE_UNREAD"),
  };
}

/* ------------------------------------------------------------------ */
/* Agreements                                                          */
/* ------------------------------------------------------------------ */

async function collectKelishuv(id: number): Promise<Collected | null> {
  const k = await get<Record<string, unknown>>(
    `SELECT k.*, l.code AS project_code, l.name AS project_name, m.title AS meeting_title,
            r.full_name AS responsible_name, c.full_name AS creator_name
       FROM kelishuvlar k
       LEFT JOIN loyihalar l ON l.id = k.loyiha_id
       LEFT JOIN meetings m ON m.id = k.meeting_id
       LEFT JOIN users r ON r.id = k.responsible_id
       LEFT JOIN users c ON c.id = k.created_by
      WHERE k.id = ?`,
    id,
  );
  if (!k) return null;
  const parties = await all<{ id: number; name: string }>(
    `SELECT p.id, p.name FROM kelishuv_parties kp JOIN partners p ON p.id = kp.company_id
      WHERE kp.kelishuv_id = ? ORDER BY p.name`,
    id,
  );
  const obligations = await all<{ description: string; deadline: string | null; status: string; owner: string | null; owner_user_id: number | null }>(
    `SELECT a.description, a.deadline, a.status, COALESCE(u.full_name, a.owner_name) AS owner, a.owner_user_id
       FROM agreements a LEFT JOIN users u ON u.id = a.owner_user_id
      WHERE a.kelishuv_id = ? ORDER BY a.id`,
    id,
  );
  let text =
    `Agreement: ${k.title}\n` +
    line("Kind", k.kind) +
    line("Status", k.status) +
    line("Parties", parties.map((party) => party.name).join(", ") || null) +
    line("Project", k.project_code ? `${k.project_code} ${k.project_name}` : null) +
    line("From meeting", k.meeting_title) +
    line("Amount", k.amount ? `${k.amount} ${k.currency ?? ""}` : null) +
    line("Signed on", k.signed_on) +
    line("Valid until", k.valid_until) +
    line("Responsible", k.responsible_name) +
    line("Recorded by", k.creator_name) +
    line("Content", k.content);
  if (obligations.length) {
    text += "\nObligations:\n";
    for (const item of obligations)
      text += `- ${item.description} — ${item.owner ?? "owner not set"}${item.deadline ? `, by ${item.deadline}` : ""} (${item.status})\n`;
  }
  let partial = false;
  let reason: SourceReason | null = null;
  if (k.file_key) {
    const file = await fileWords(k.file_key as string, k.file_name as string, { full: true });
    if (file.text) text += `\nSigned copy "${k.file_name}":\n${file.text}\n`;
    else {
      text += `\nSigned copy "${k.file_name}" — not read.\n`;
      partial = true;
      reason = file.reason;
    }
  }
  const facts: DerivedFact[] = obligations.map((item) => ({
    kind: "commitment",
    subject: String(k.title),
    statement: item.description,
    who: item.owner,
    whoUserId: item.owner_user_id,
    dueOn: item.deadline,
  }));
  if (k.valid_until)
    facts.push({
      kind: "deadline",
      subject: String(k.title),
      statement: `The agreement "${k.title}" is valid until ${k.valid_until}.`,
      who: (k.responsible_name as string | null) ?? null,
      whoUserId: (k.responsible_id as number | null) ?? null,
      dueOn: k.valid_until as string,
    });
  return {
    title: String(k.title),
    text,
    occurredAt: day((k.signed_on as string | null) ?? (k.created_at as string)),
    authorId: (k.created_by as number | null) ?? null,
    lang: null,
    reliability: RELIABILITY.kelishuv,
    scope: {
      projectId: (k.loyiha_id as number | null) ?? null,
      companyId: parties[0]?.id ?? null,
      meetingId: (k.meeting_id as number | null) ?? null,
    },
    links: [
      ...parties.map((party) => ({ toKind: "company" as const, toId: party.id, relation: "about" })),
      ...(k.loyiha_id ? [{ toKind: "project" as const, toId: Number(k.loyiha_id), relation: "about" }] : []),
    ],
    partial,
    reason,
    facts,
  };
}

async function collectAgreement(id: number): Promise<Collected | null> {
  const a = await get<Record<string, unknown>>(
    `SELECT a.*, COALESCE(u.full_name, a.owner_name) AS owner, p.name AS company_name,
            m.title AS meeting_title, t.code AS task_code, k.title AS kelishuv_title,
            c.full_name AS creator_name
       FROM agreements a
       LEFT JOIN users u ON u.id = a.owner_user_id
       LEFT JOIN partners p ON p.id = a.company_id
       LEFT JOIN meetings m ON m.id = a.meeting_id
       LEFT JOIN tasks t ON t.id = a.task_id
       LEFT JOIN kelishuvlar k ON k.id = a.kelishuv_id
       LEFT JOIN users c ON c.id = a.created_by
      WHERE a.id = ?`,
    id,
  );
  if (!a) return null;
  const text =
    `Commitment: ${a.description}\n` +
    line("Status", a.status) +
    line("Priority", a.priority) +
    line("Responsible", a.owner) +
    line("Deadline", a.deadline) +
    line("Company", a.company_name) +
    line("From meeting", a.meeting_title) +
    line("Under agreement", a.kelishuv_title) +
    line("Tracked as task", a.task_code) +
    line("Recorded by", a.creator_name) +
    line("Recorded", day(a.created_at as string)) +
    line("Done", day(a.done_at as string | null)) +
    line("Note", a.note) +
    line("Origin", a.source);
  return {
    title: String(a.description).slice(0, 120),
    text,
    occurredAt: day(a.created_at as string),
    authorId: (a.created_by as number | null) ?? null,
    lang: null,
    reliability: RELIABILITY.agreement,
    scope: {
      companyId: (a.company_id as number | null) ?? null,
      meetingId: (a.meeting_id as number | null) ?? null,
      taskId: (a.task_id as number | null) ?? null,
      projectId: (a.loyiha_id as number | null) ?? null,
    },
    links: [
      ...(a.company_id ? [{ toKind: "company" as const, toId: Number(a.company_id), relation: "about" }] : []),
      ...(a.owner_user_id ? [{ toKind: "person" as const, toId: Number(a.owner_user_id), relation: "assigned" }] : []),
    ],
    facts: [
      {
        kind: "commitment",
        subject: (a.company_name as string | null) ?? null,
        statement: String(a.description),
        who: (a.owner as string | null) ?? null,
        whoUserId: (a.owner_user_id as number | null) ?? null,
        dueOn: (a.deadline as string | null) ?? null,
        taskId: (a.task_id as number | null) ?? null,
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Projects                                                            */
/* ------------------------------------------------------------------ */

async function collectProject(id: number): Promise<Collected | null> {
  const p = await get<Record<string, unknown>>(
    `SELECT l.*, o.full_name AS owner_full_name, d.full_name AS deputy_full_name,
            k.code AS cluster_code, k.name_uz AS cluster_name, y.name AS uyushma_name
       FROM loyihalar l
       LEFT JOIN users o ON o.id = l.owner_id
       LEFT JOIN users d ON d.id = l.deputy_id
       LEFT JOIN klasterlar k ON k.id = l.klaster_id
       LEFT JOIN uyushmalar y ON y.id = l.uyushma_id
      WHERE l.id = ?`,
    id,
  );
  if (!p) return null;
  const stages = await all<Record<string, unknown>>(
    "SELECT * FROM project_stages WHERE project_id = ? ORDER BY position",
    id,
  );
  const members = await all<{ id: number; full_name: string }>(
    `SELECT u.id, u.full_name FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = ? ORDER BY u.full_name`,
    id,
  );
  let text =
    `Project passport — ${p.code} ${p.name}\n` +
    line("Name (ru)", p.name_ru) +
    line("Name (en)", p.name_en) +
    line("Status", p.status) +
    line("Phase", p.phase) +
    line("Current state", p.stage) +
    line("Tier", p.tier) +
    line("Priority", p.priority) +
    line("Progress", `${p.progress}%`) +
    line("Budget", p.budget) +
    line("Cluster", p.cluster_code ? `${p.cluster_code} ${p.cluster_name}` : null) +
    line("Association", p.uyushma_name) +
    line("Leader", p.owner_full_name ?? p.leader_name) +
    line("Deputy", p.deputy_full_name ?? p.deputy_name) +
    line("Team", members.map((member) => member.full_name).join(", ") || null) +
    line("Started", p.started_at) +
    line("Deadline", p.deadline) +
    line("Next decision on", p.next_decision_on) +
    line("First result", p.first_result) +
    line(
      "PPP shares",
      p.ppp_state || p.ppp_public || p.ppp_private
        ? `state ${p.ppp_state ?? 0}% (${p.ppp_state_party ?? ""}), public ${p.ppp_public ?? 0}% (${p.ppp_public_party ?? ""}), private ${p.ppp_private ?? 0}% (${p.ppp_private_party ?? ""})`
        : null,
    ) +
    line("Description", p.description) +
    line("Description (ru)", p.description_ru) +
    line("Description (en)", p.description_en);
  if (stages.length) {
    text += "\nWork schedule:\n";
    for (const stage of stages)
      text +=
        `- ${stage.position}. ${stage.name}: planned ${stage.plan_start} → ${stage.plan_end}` +
        (stage.fact_start ? `, started ${stage.fact_start}` : "") +
        (stage.fact_end ? `, finished ${stage.fact_end}` : "") +
        `, ${stage.progress}%` +
        (stage.delay_reason ? `; delay reason: ${stage.delay_reason}` : "") +
        (stage.help_needed ? `; help needed: ${stage.help_needed}` : "") +
        "\n";
  }
  const facts: DerivedFact[] = [];
  if (p.next_decision_on)
    facts.push({
      kind: "deadline",
      subject: `${p.code} ${p.name}`,
      statement: `The next decision on ${p.code} ${p.name} is due on ${p.next_decision_on}.`,
      who: (p.owner_full_name as string | null) ?? null,
      whoUserId: (p.owner_id as number | null) ?? null,
      dueOn: p.next_decision_on as string,
    });
  return {
    title: `${p.code} · ${p.name}`,
    text,
    occurredAt: day((p.started_at as string | null) ?? (p.created_at as string)),
    authorId: (p.owner_id as number | null) ?? null,
    lang: null,
    reliability: RELIABILITY.project,
    scope: { projectId: id, uyushmaId: (p.uyushma_id as number | null) ?? null },
    links: [
      ...(p.owner_id ? [{ toKind: "person" as const, toId: Number(p.owner_id), relation: "assigned" }] : []),
      ...members.map((member) => ({ toKind: "person" as const, toId: member.id, relation: "mentions" })),
    ],
    facts,
  };
}

/* ------------------------------------------------------------------ */

export async function collect(kind: SourceKind, refId: number): Promise<Collected | null> {
  switch (kind) {
    case "task":
      return collectTask(refId);
    case "meeting":
      return collectMeeting(refId);
    case "thread_entry":
      return collectEntry(refId);
    case "message":
      return collectMessage(refId);
    case "project_document":
      return collectProjectDocument(refId);
    case "library":
      return collectLibrary(refId);
    case "kelishuv":
      return collectKelishuv(refId);
    case "agreement":
      return collectAgreement(refId);
    case "project":
      return collectProject(refId);
    default:
      return null;
  }
}

/** 'YYYY-MM-DD HH:MM:SS' now — re-exported for the pipeline's stamps. */
export { now };
