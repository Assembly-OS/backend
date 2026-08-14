import { all, get, now, run } from "@/lib/db";
import { publish } from "@/lib/events";
import { notify } from "@/lib/notifications";
import { notifyBot } from "@/lib/notify-bot";
import { assignableUsers } from "@/lib/queries";
import type { User } from "@/lib/types";
import {
  agentById,
  needsApproval,
  type ActionVerb,
  type AgentSpec,
} from "./registry";
import {
  analyzeDocument,
  analyzeMeeting,
  pick,
  type Candidate,
  type DraftTask,
  type MeetingAnalysis,
} from "./intake";
import { recallMemory, rememberFacts } from "./live";
import { recordPartners } from "./partners";
import type { ExtractedSource } from "./extract";

/**
 * Runs the two submission-driven agents and files what they produce.
 *
 * The trust boundary is here rather than in the model call. Whatever the model
 * returns is filtered against two things the model does not control: the set of
 * people this particular submitter is allowed to assign work to, and the
 * agent's declared action scope. A draft naming someone outside that set is
 * dropped with a reason, not quietly reassigned — a wrong owner on a real
 * assignment is worse than a missing one.
 *
 * Once a draft clears that filter it is carried out immediately: the assignment
 * is created and the owner gets his Telegram ping in the same request that
 * uploaded the document. The approval queue is still here and still works — it
 * is what a draft falls back to when execution fails — but it is no longer on
 * the path between a submitted order and the people who have to act on it.
 */

/**
 * Off switch for the automatic distribution, without a code change: set
 * `AI_AUTO_ASSIGN=0` and every extracted assignment goes back to waiting for
 * a human. The registry still decides *which* verbs are eligible.
 */
const AUTO_ENABLED = process.env.AI_AUTO_ASSIGN !== "0";

function runsImmediately(agent: AgentSpec, action: ActionVerb): boolean {
  return AUTO_ENABLED && !needsApproval(agent, action);
}

/** Marks a proposal as carried out, with what it produced. */
function markExecuted(proposalId: number, result: string): void {
  run(
    `UPDATE agent_proposals
        SET status = 'executed', decided_by = 'avto', decided_at = ?, result = ?
      WHERE id = ?`,
    now(),
    result.slice(0, 200),
    proposalId,
  );
}

export interface IntakeResult {
  runId: number;
  status: "ok" | "blocked";
  detail?: string;
  /** Assignments created outright. */
  created: number;
  /** Assignments filed but still awaiting a person (execution failed). */
  drafts: number;
  dropped: number;
  summary?: string;
  keyPoints?: string[];
  /** Facts filed into the platform's memory by this run. */
  remembered?: number;
  /** Companies this meeting touched, and suggestions raised for them. */
  partners?: number;
  ideas?: number;
}

/** People this submitter may hand work to, in the shape the model is shown. */
function candidatesFor(user: User): Candidate[] {
  return assignableUsers(user).map((person) => ({
    login: person.login,
    full_name: person.full_name,
    role: person.role,
    department: person.department,
    position: person.position,
  }));
}

function writeRun(fields: {
  agent: string;
  owner: User;
  sourceKind: string;
  sourceRef: string;
  status: "ok" | "blocked";
  detail?: string;
  contextRows?: number;
  proposals?: number;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
  usedModel?: string;
}): number {
  run(
    `INSERT INTO agent_runs
       (agent, trigger, actor, status, detail, context_rows, proposals,
        tokens_in, tokens_out, duration_ms, used_model,
        owner_user_id, source_kind, source_ref, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    fields.agent,
    "event",
    fields.owner.login,
    fields.status,
    fields.detail ?? null,
    fields.contextRows ?? 0,
    fields.proposals ?? 0,
    fields.tokensIn ?? 0,
    fields.tokensOut ?? 0,
    fields.durationMs ?? 0,
    fields.usedModel ?? null,
    fields.owner.id,
    fields.sourceKind,
    fields.sourceRef,
    now(),
  );
  return Number(get<{ id: number }>("SELECT MAX(id) AS id FROM agent_runs")!.id);
}

/**
 * Who checks a drafted assignment before it becomes one.
 *
 * The head of the department the work lands in — the person who knows whether
 * the model read the document right, whether that colleague is the correct
 * owner, and whether the deadline is achievable. Falling back to the submitter
 * when a department has no head is deliberate: a proposal routed to nobody is
 * a proposal nobody acts on.
 */
function reviewerFor(assigneeId: number, owner: User): number {
  const assignee = get<{ department: string | null; id: number }>(
    "SELECT id, department FROM users WHERE id = ?",
    assigneeId,
  );
  if (assignee?.department) {
    const head = get<{ id: number }>(
      `SELECT id FROM users
        WHERE is_active = 1 AND role = 'BOLIM_RAHBARI' AND department = ?
        ORDER BY id LIMIT 1`,
      assignee.department,
    );
    if (head) return head.id;
  }
  return owner.id;
}

/**
 * Files one extracted task and, when the agent is allowed to, creates it.
 *
 *  - `dropped`  — the model named somebody this submitter may not assign to.
 *  - `created`  — the assignment exists and its owner has been notified.
 *  - `queued`   — filed, but execution failed or auto-assign is off; a human
 *                 finishes it from the approval queue.
 *
 * The proposal row is written first either way, so a task can never exist
 * without the record of which run produced it.
 */
function fileDraft(
  runId: number,
  agent: AgentSpec,
  owner: User,
  draft: DraftTask,
  allowed: Map<string, Candidate>,
): "created" | "queued" | "dropped" {
  const target = allowed.get(draft.assignee?.trim().toLowerCase() ?? "");
  if (!target) return "dropped";

  const assignee = get<{ id: number }>(
    "SELECT id FROM users WHERE login = ? AND is_active = 1",
    target.login,
  );
  if (!assignee) return "dropped";

  const deadline = /^\d{4}-\d{2}-\d{2}$/.test(draft.deadline)
    ? draft.deadline
    : null;

  run(
    `INSERT INTO agent_proposals
       (run_id, agent, action, title, body, severity, subject_kind, subject_id,
        payload, status, owner_user_id, reviewer_user_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    runId,
    agent.id,
    "suggest_task",
    draft.title.slice(0, 200),
    `${draft.description}\n\nMas'ul: ${target.full_name} (@${target.login})` +
      `${deadline ? `\nMuddat: ${deadline}` : ""}` +
      `\nMuhimlik: ${draft.priority}\n\nAsos: ${draft.rationale}`,
    draft.priority === "KRITIK" || draft.priority === "YUQORI" ? "P2" : "P3",
    "user",
    assignee.id,
    JSON.stringify({
      toUserId: assignee.id,
      title: draft.title.slice(0, 200),
      description: draft.description,
      priority: draft.priority,
      deadline,
    }),
    "pending",
    owner.id,
    reviewerFor(assignee.id, owner),
    now(),
  );

  if (!runsImmediately(agent, "suggest_task")) return "queued";

  const proposalId = Number(
    get<{ id: number }>("SELECT MAX(id) AS id FROM agent_proposals")!.id,
  );
  try {
    const code = createTaskFromProposal(owner.id, {
      toUserId: assignee.id,
      title: draft.title.slice(0, 200),
      description: draft.description,
      priority: draft.priority,
      deadline,
    });
    markExecuted(proposalId, `topshiriq yaratildi: ${code}`);
    return "created";
  } catch {
    // The assignment graph refused it, or the row would not write. The
    // proposal stays `pending` rather than disappearing — one that needs a
    // person is better than one that is silently lost.
    return "queued";
  }
}

/**
 * A document in, draft assignments out — PDF, scan, photo, Word, Excel,
 * PowerPoint or plain text. Nothing is created until a human approves.
 */
export async function runDocumentIntake(
  owner: User,
  bytes: Buffer,
  source: ExtractedSource,
  fileName: string,
  fileKey: string,
): Promise<IntakeResult> {
  const started = Date.now();
  const agent = agentById("document")!;

  const candidates = candidatesFor(owner);
  if (candidates.length === 0) {
    const runId = writeRun({
      agent: agent.id,
      owner,
      sourceKind: source.kind,
      sourceRef: fileKey,
      status: "blocked",
      detail: "Sizga topshiriq taqsimlash huquqi berilmagan",
      durationMs: Date.now() - started,
    });
    return {
      runId,
      status: "blocked",
      detail: "Sizga topshiriq taqsimlash huquqi berilmagan",
      created: 0,
      drafts: 0,
      dropped: 0,
    };
  }

  const analysis = await analyzeDocument(
    bytes,
    source,
    fileName,
    candidates,
    agent.tokenBudget,
  );
  if (!analysis) {
    const runId = writeRun({
      agent: agent.id,
      owner,
      sourceKind: source.kind,
      sourceRef: fileKey,
      status: "blocked",
      detail: "AI tahlili amalga oshmadi (kalit yoki xizmat mavjud emas)",
      durationMs: Date.now() - started,
    });
    return {
      runId,
      status: "blocked",
      detail: "AI tahlili amalga oshmadi",
      created: 0,
      drafts: 0,
      dropped: 0,
    };
  }

  const allowed = new Map(
    candidates.map((person) => [person.login.toLowerCase(), person]),
  );
  const runId = writeRun({
    agent: agent.id,
    owner,
    sourceKind: source.kind,
    sourceRef: fileKey,
    status: "ok",
    contextRows: candidates.length,
    proposals: analysis.tasks.length,
    tokensIn: analysis.tokensIn,
    tokensOut: analysis.tokensOut,
    durationMs: Date.now() - started,
    usedModel: analysis.model,
  });

  run(
    `INSERT INTO agent_proposals
       (run_id, agent, action, title, body, severity, status, owner_user_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    runId,
    agent.id,
    "report",
    analysis.documentTitle.slice(0, 200) || fileName,
    analysis.summary,
    "P3",
    "auto",
    owner.id,
    now(),
  );

  let created = 0;
  let drafts = 0;
  let dropped = 0;
  for (const draft of analysis.tasks) {
    const outcome = fileDraft(runId, agent, owner, draft, allowed);
    if (outcome === "created") created++;
    else if (outcome === "queued") drafts++;
    else dropped++;
  }

  const notes: string[] = [];
  if (created > 0) notes.push(`${created} ta topshiriq yaratildi`);
  if (dropped > 0)
    notes.push(`${dropped} ta taklif noto'g'ri mas'ul tufayli rad etildi`);
  if (notes.length > 0) {
    run(
      "UPDATE agent_runs SET detail = ? WHERE id = ?",
      notes.join("; "),
      runId,
    );
  }

  return {
    runId,
    status: "ok",
    created,
    drafts,
    dropped,
    summary: analysis.summary,
  };
}

/**
 * Who receives the meeting brief: the chairman, plus whoever runs his office.
 * `MEETING_BRIEF_LOGINS` overrides the default without a code change.
 */
/** The summary, key points and decisions as one readable block. */
function briefIn(analysis: MeetingAnalysis, lang: string): string {
  const points = analysis.keyPoints.map((item) => pick(item, lang)).filter(Boolean);
  const decisions = analysis.decisions.map((item) => pick(item, lang)).filter(Boolean);
  const labels =
    lang === "ru"
      ? { points: "Ключевые пункты", decisions: "Решения" }
      : lang === "en"
        ? { points: "Key points", decisions: "Decisions" }
        : { points: "Asosiy nuqtalar", decisions: "Qarorlar" };

  return (
    `${pick(analysis.summary, lang)}\n\n` +
    (points.length ? `${labels.points}:\n${points.map((p) => `• ${p}`).join("\n")}\n\n` : "") +
    (decisions.length ? `${labels.decisions}:\n${decisions.map((d) => `• ${d}`).join("\n")}` : "")
  );
}

function briefRecipients(): { id: number; full_name: string; lang: string | null }[] {
  const extra = (process.env.MEETING_BRIEF_LOGINS ?? "muslimbek.komiljonov")
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean);

  const marks = extra.map(() => "?").join(",") || "''";
  return all<{ id: number; full_name: string; lang: string | null }>(
    `SELECT id, full_name, lang FROM users
      WHERE is_active = 1
        AND (role = 'RAIS' OR LOWER(login) IN (${marks}))`,
    ...extra,
  );
}

/** Transcript in; key points to the chairman's desk and draft assignments. */
export async function runMeetingIntake(
  owner: User,
  meetingId: number,
  title: string,
  transcript: string,
  lang = "uz-UZ",
): Promise<IntakeResult> {
  const started = Date.now();
  const agent = agentById("meeting")!;
  const candidates = candidatesFor(owner);

  const analysis = await analyzeMeeting(
    transcript,
    title,
    candidates,
    agent.tokenBudget,
    lang,
    // What earlier meetings left behind, so this one does not re-derive the
    // decisions they already reached.
    recallMemory(),
  );
  if (!analysis) {
    const runId = writeRun({
      agent: agent.id,
      owner,
      sourceKind: "transcript",
      sourceRef: String(meetingId),
      status: "blocked",
      detail: "AI tahlili amalga oshmadi (kalit yoki xizmat mavjud emas)",
      durationMs: Date.now() - started,
    });
    return {
      runId,
      status: "blocked",
      detail: "AI tahlili amalga oshmadi",
      created: 0,
      drafts: 0,
      dropped: 0,
    };
  }

  const runId = writeRun({
    agent: agent.id,
    owner,
    sourceKind: "transcript",
    sourceRef: String(meetingId),
    status: "ok",
    contextRows: candidates.length,
    proposals: analysis.tasks.length,
    tokensIn: analysis.tokensIn,
    tokensOut: analysis.tokensOut,
    durationMs: Date.now() - started,
    usedModel: analysis.model,
  });

  // Written once per language, so the page can show whichever the reader is
  // using without a second model call — and so a conclusion survives even if
  // every task it produced is later rejected.
  for (const code of ["uz", "ru", "en"] as const) {
    run(
      `INSERT OR REPLACE INTO meeting_conclusions
         (meeting_id, lang, summary, key_points, decisions, created_at)
       VALUES (?,?,?,?,?,?)`,
      meetingId,
      code,
      pick(analysis.summary, code),
      JSON.stringify(analysis.keyPoints.map((item) => pick(item, code))),
      JSON.stringify(analysis.decisions.map((item) => pick(item, code))),
      now(),
    );
  }

  const brief = briefIn(analysis, owner.lang ?? "uz");

  run(
    `INSERT INTO agent_proposals
       (run_id, agent, action, title, body, severity, subject_kind, subject_id,
        status, owner_user_id, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    runId,
    agent.id,
    "report",
    title,
    brief.trim(),
    "P3",
    "meeting",
    meetingId,
    "auto",
    owner.id,
    now(),
  );

  // The brief goes to the chairman and his assistant as the meeting ends —
  // that is the whole point of recording it. The proposal row is still written
  // first, so the audit log shows what was sent and to whom.
  const sendNow = runsImmediately(agent, "notify");
  for (const recipient of briefRecipients()) {
    // Each recipient reads the conclusion in the language they set for
    // themselves — the analysis already produced all three.
    const theirs = briefIn(analysis, recipient.lang ?? "uz");
    run(
      `INSERT INTO agent_proposals
         (run_id, agent, action, title, body, severity, subject_kind, subject_id,
          payload, status, owner_user_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      runId,
      agent.id,
      "notify",
      `Xulosa: ${title} → ${recipient.full_name}`,
      theirs.trim(),
      "P2",
      "user",
      recipient.id,
      JSON.stringify({ toUserId: recipient.id }),
      "pending",
      owner.id,
      now(),
    );
    if (!sendNow) continue;

    const proposalId = Number(
      get<{ id: number }>("SELECT MAX(id) AS id FROM agent_proposals")!.id,
    );
    notifyBot(
      recipient.id,
      // Telegram rejects a message over 4096 characters outright, and a brief
      // that long has already failed at being a brief.
      `🤖 <b>${title}</b>\n${theirs.trim()}`.slice(0, 3800),
    );
    markExecuted(proposalId, `xabar yuborildi: ${recipient.full_name}`);
  }

  // What this meeting should still be known for. Written before the tasks so
  // a failure to create one does not cost the record of why it existed.
  const remembered = rememberFacts(meetingId, analysis.memory ?? []);
  // Who this meeting was with, and what to put to them next.
  const partners = recordPartners(meetingId, analysis.partners ?? []);

  const allowed = new Map(
    candidates.map((person) => [person.login.toLowerCase(), person]),
  );
  let created = 0;
  let drafts = 0;
  let dropped = 0;
  for (const draft of analysis.tasks) {
    const outcome = fileDraft(runId, agent, owner, draft, allowed);
    if (outcome === "created") created++;
    else if (outcome === "queued") drafts++;
    else dropped++;
  }

  if (created > 0) {
    run(
      "UPDATE agent_runs SET detail = ? WHERE id = ?",
      `${created} ta topshiriq yaratildi`,
      runId,
    );
  }

  return {
    runId,
    status: "ok",
    created,
    drafts,
    dropped,
    summary: pick(analysis.summary, owner.lang ?? "uz"),
    keyPoints: analysis.keyPoints.map((item) => pick(item, owner.lang ?? "uz")),
    remembered,
    partners: partners.companies,
    ideas: partners.ideas,
  };
}

/* ------------------------------------------------------------------ */
/* EXECUTION of an approved draft assignment                           */
/* ------------------------------------------------------------------ */

/**
 * Creates the real assignment behind an approved `suggest_task`. Deliberately
 * the same shape a person's own form produces — same code sequence, same audit
 * event, same Telegram ping — so nothing downstream can tell an AI-drafted
 * task from a hand-written one except the audit trail that says so.
 */
export function createTaskFromProposal(
  ownerId: number,
  payload: {
    toUserId: number;
    title: string;
    description?: string;
    priority?: string;
    deadline?: string | null;
  },
): string {
  const author = get<User>("SELECT * FROM users WHERE id = ?", ownerId);
  const assignee = get<User>(
    "SELECT * FROM users WHERE id = ? AND is_active = 1",
    payload.toUserId,
  );
  if (!author || !assignee) throw new Error("Mas'ul topilmadi");

  // Re-check the assignment graph at execution time: the approver may have
  // lost the right to assign since the draft was filed.
  if (!assignableUsers(author).some((person) => person.id === assignee.id)) {
    throw new Error("Bu xodimga topshiriq berish huquqi yo'q");
  }

  const seq =
    Number(get<{ c: number }>("SELECT COUNT(*) AS c FROM tasks")?.c ?? 0) + 1;
  const code = `T-${String(seq).padStart(4, "0")}`;
  const stamp = now();

  run(
    `INSERT INTO tasks (code, title, description, from_user_id, to_user_id,
                        to_department, priority, status, deadline, uyushma_id, created_at)
     VALUES (?,?,?,?,?,?,?,'YANGI',?,?,?)`,
    code,
    payload.title,
    payload.description ?? null,
    author.id,
    assignee.id,
    assignee.department,
    payload.priority ?? "ORTA",
    payload.deadline ?? null,
    assignee.uyushma_id ?? null,
    stamp,
  );

  const taskId = Number(
    get<{ id: number }>("SELECT id FROM tasks WHERE code = ?", code)!.id,
  );
  run(
    "INSERT INTO task_events (task_id, user_id, action, comment, created_at) VALUES (?,?,'YARATILDI',?,?)",
    taskId,
    author.id,
    "AI taklifi asosida, tasdiqlangan",
    stamp,
  );

  publish(author.id, assignee.id);
  notify({
    userId: assignee.id,
    kind: "task",
    title: `${code} · ${payload.title}`,
    body: payload.deadline ? `⏰ ${payload.deadline}` : "",
    href: "/tasks/inbox",
    entity: "task",
    entityId: taskId,
    push: true,
  });

  return code;
}
