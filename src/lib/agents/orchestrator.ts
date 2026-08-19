import { all, get, insert, now, run } from "@/lib/pg";
import { notifyBot } from "@/lib/notify-bot";
import { analyze, type Finding } from "./analyzers";
import { createTaskFromProposal } from "./intake-runner";
import { summarize } from "./claude";
import { loadContext } from "./context";
import {
  agentById,
  needsApproval,
  type ActionVerb,
  type AgentSpec,
} from "./registry";

/**
 * The orchestrator of TZ §10.1.
 *
 *   TRIGGER → CONTEXT RETRIEVAL → POLICY CHECK → ANALYSIS →
 *   PROPOSED ACTION → HUMAN APPROVAL → EXECUTION → AUDIT LOG
 *
 * Every step is here, in that order, and nothing else in the codebase runs an
 * agent. That matters more than it looks: the specification's "MUHIM" note
 * requires that agents not form an unbounded autonomous system, and the way
 * this implementation guarantees it is structural rather than instructional —
 * an agent is a row in a registry plus a pure function over a context object.
 * It holds no database handle, cannot call another agent, cannot enlarge its
 * own scope, and cannot execute its own proposals.
 */

export type Trigger = "manual" | "schedule" | "event";

export interface RunResult {
  runId: number;
  status: "ok" | "blocked";
  detail?: string;
  proposals: number;
  autoApplied: number;
  pending: number;
  summary?: string;
  model?: string;
}

export interface PolicyVerdict {
  allowed: boolean;
  reason?: string;
}

/**
 * POLICY CHECK — step 3. Runs before any analysis and before any model call,
 * so a refusal costs nothing and is still written to the audit log.
 */
export function policyCheck(agent: AgentSpec): PolicyVerdict {
  if (agent.status !== "active") {
    return {
      allowed: false,
      reason: agent.blockedBy ?? "Agent hali faollashtirilmagan",
    };
  }
  if (agent.dataScope.length === 0) {
    return { allowed: false, reason: "Ma'lumot doirasi bo'sh" };
  }
  if (agent.actionScope.length === 0) {
    return { allowed: false, reason: "Harakat doirasi bo'sh" };
  }
  if (agent.tokenBudget <= 0) {
    return { allowed: false, reason: "Token limiti belgilanmagan" };
  }
  return { allowed: true };
}

/** Records the run row that every path — including a refusal — ends with. */
async function writeRun(fields: {
  agent: string;
  trigger: Trigger;
  actor: string;
  status: "ok" | "blocked" | "error";
  detail?: string;
  contextRows?: number;
  proposals?: number;
  tokensIn?: number;
  tokensOut?: number;
  durationMs?: number;
  usedModel?: string;
}): Promise<number> {
  // RETURNING rather than a follow-up SELECT MAX(id): the bot and the web app
  // write to the same database now, so the largest id is not necessarily the
  // row this call just wrote.
  return await insert(
    `INSERT INTO agent_runs
       (agent, trigger, actor, status, detail, context_rows, proposals,
        tokens_in, tokens_out, duration_ms, used_model, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    fields.agent,
    fields.trigger,
    fields.actor,
    fields.status,
    fields.detail ?? null,
    fields.contextRows ?? 0,
    fields.proposals ?? 0,
    fields.tokensIn ?? 0,
    fields.tokensOut ?? 0,
    fields.durationMs ?? 0,
    fields.usedModel ?? null,
    now(),
  );
}

/**
 * Runs one agent end to end. The only entry point — API routes and any future
 * scheduler both come through here, so no caller can skip a step.
 */
export async function runAgent(
  agentId: string,
  trigger: Trigger,
  actor: string,
): Promise<RunResult> {
  const started = Date.now();
  const agent = agentById(agentId);

  if (!agent) {
    const runId = await writeRun({
      agent: agentId,
      trigger,
      actor,
      status: "blocked",
      detail: "Noma'lum agent",
    });
    return { runId, status: "blocked", detail: "Noma'lum agent", proposals: 0, autoApplied: 0, pending: 0 };
  }

  const verdict = policyCheck(agent);
  if (!verdict.allowed) {
    const runId = await writeRun({
      agent: agent.id,
      trigger,
      actor,
      status: "blocked",
      detail: verdict.reason,
      durationMs: Date.now() - started,
    });
    return {
      runId,
      status: "blocked",
      detail: verdict.reason,
      proposals: 0,
      autoApplied: 0,
      pending: 0,
    };
  }

  // CONTEXT RETRIEVAL — exactly the declared scopes, nothing wider.
  const context = await loadContext(agent.dataScope);

  // ANALYSIS — deterministic, over that context only.
  const findings = analyze(agent.id, context);

  // A finding whose verb is outside the declared action scope is dropped, not
  // executed and not queued. Belt to the analyzer's braces: the registry is
  // the authority on what an agent may propose.
  const allowed: Finding[] = [];
  const refused: Finding[] = [];
  for (const finding of findings) {
    if (agent.actionScope.includes(finding.action)) allowed.push(finding);
    else refused.push(finding);
  }

  const summary = await summarize(agent, allowed, agent.tokenBudget);

  const runId = await writeRun({
    agent: agent.id,
    trigger,
    actor,
    status: "ok",
    detail: refused.length
      ? `${refused.length} ta taklif harakat doirasidan tashqarida bo'lgani uchun rad etildi`
      : undefined,
    contextRows: context.rows,
    proposals: allowed.length,
    tokensIn: summary?.tokensIn ?? 0,
    tokensOut: summary?.tokensOut ?? 0,
    durationMs: Date.now() - started,
    usedModel: summary?.model,
  });

  // PROPOSED ACTION → HUMAN APPROVAL. Anything with a side effect is written
  // as `pending` and waits; a read-only verb is marked `auto` and is complete
  // on the spot, because "applying" it means only that it was recorded.
  let autoApplied = 0;
  let pending = 0;

  for (const finding of allowed) {
    const gated = needsApproval(agent, finding.action);
    await run(
      `INSERT INTO agent_proposals
         (run_id, agent, action, title, body, severity, subject_kind, subject_id,
          payload, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      runId,
      agent.id,
      finding.action,
      finding.title,
      `${finding.body}\n\nManba: ${finding.evidence}`,
      finding.severity,
      finding.subjectKind ?? null,
      finding.subjectId ?? null,
      finding.payload ? JSON.stringify(finding.payload) : null,
      gated ? "pending" : "auto",
      now(),
    );
    if (gated) pending++;
    else autoApplied++;
  }

  if (summary) {
    await run(
      `INSERT INTO agent_proposals
         (run_id, agent, action, title, body, severity, status, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      runId,
      agent.id,
      "report",
      "AI xulosasi",
      summary.text,
      "P3",
      "auto",
      now(),
    );
    autoApplied++;
  }

  return {
    runId,
    status: "ok",
    proposals: allowed.length,
    autoApplied,
    pending,
    summary: summary?.text,
    model: summary?.model,
  };
}

/* ------------------------------------------------------------------ */
/* EXECUTION — only ever reached through a human decision              */
/* ------------------------------------------------------------------ */

interface ProposalRow {
  id: number;
  agent: string;
  action: ActionVerb;
  title: string;
  body: string;
  severity: string;
  subject_kind: string | null;
  subject_id: number | null;
  payload: string | null;
  status: string;
  /** The person who submitted the source, when the run had one. */
  owner_user_id: number | null;
  /** The department head who must check it before it takes effect. */
  reviewer_user_id: number | null;
}

/**
 * Corrections a reviewer made before approving.
 *
 * The model read a document; the head reading the proposal knows the
 * department. Both are usually right, and where they differ the head wins —
 * so approval carries the corrected values rather than forcing a reject and a
 * re-upload of the same file.
 */
export interface ProposalEdits {
  title?: string;
  description?: string;
  priority?: string;
  deadline?: string | null;
  toUserId?: number;
}

/**
 * Applies an approved proposal. This is the only code that lets an agent's
 * intent reach the outside world, and it runs after a named human said yes —
 * TZ §16 AI-03: nothing leaves the system without approval.
 */
export async function decideProposal(
  proposalId: number,
  decision: "approve" | "reject",
  decidedBy: string,
  edits?: ProposalEdits,
): Promise<{ ok: boolean; error?: string; result?: string }> {
  const proposal = await get<ProposalRow>(
    "SELECT * FROM agent_proposals WHERE id = ?",
    proposalId,
  );
  if (!proposal) return { ok: false, error: "NOT_FOUND" };
  if (proposal.status !== "pending") return { ok: false, error: "NOT_PENDING" };

  if (decision === "reject") {
    await run(
      "UPDATE agent_proposals SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?",
      decidedBy,
      now(),
      proposalId,
    );
    return { ok: true, result: "rejected" };
  }

  // Re-check the scope at execution time. The registry may have changed since
  // the proposal was queued, and a stale approval must not widen it.
  const agent = agentById(proposal.agent);
  if (!agent || !agent.actionScope.includes(proposal.action)) {
    await run(
      "UPDATE agent_proposals SET status = 'failed', decided_by = ?, decided_at = ?, result = ? WHERE id = ?",
      decidedBy,
      now(),
      "Harakat agent doirasidan tashqarida",
      proposalId,
    );
    return { ok: false, error: "OUT_OF_SCOPE" };
  }

  let result = "qayd etildi";
  try {
    const payload = proposal.payload
      ? (JSON.parse(proposal.payload) as Record<string, unknown>)
      : {};

    if (proposal.action === "suggest_task") {
      // Creating the assignment is the whole point of the approval — until
      // this line runs, an AI-drafted task exists only as a proposal.
      if (!proposal.owner_user_id) throw new Error("Muallif aniqlanmadi");

      // The reviewer's corrections override the draft field by field; an
      // omitted field keeps what the model proposed.
      const title = (edits?.title ?? payload.title ?? proposal.title) as string;
      const toUserId = Number(edits?.toUserId ?? payload.toUserId);
      const deadline =
        edits?.deadline !== undefined
          ? edits.deadline
          : payload.deadline
            ? String(payload.deadline)
            : null;

      const code = await createTaskFromProposal(proposal.owner_user_id, {
        toUserId,
        title: String(title).slice(0, 200),
        description: String(
          edits?.description ?? payload.description ?? "",
        ) || undefined,
        priority: String(edits?.priority ?? payload.priority ?? "ORTA"),
        deadline: deadline && /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : null,
      });
      const touched = edits && Object.keys(edits).length > 0;
      result = `topshiriq yaratildi: ${code}${touched ? " (tahrirlangan)" : ""}`;
    } else if (proposal.action === "notify" || proposal.action === "escalate") {
      // The one outward-facing effect the platform has today: a Telegram
      // message through the bot. Silently a no-op when the person has not
      // linked Telegram, which notifyBot already handles.
      const target = Number(payload.toUserId);
      if (Number.isInteger(target) && target > 0) {
        notifyBot(
          target,
          `🤖 <b>${proposal.title}</b>\n${proposal.body.split("\n\n")[0]}`,
        );
        result = `xabar yuborildi (pid ${target})`;
      } else {
        result = "qabul qiluvchi aniqlanmadi";
      }
    }
  } catch (error) {
    await run(
      "UPDATE agent_proposals SET status = 'failed', decided_by = ?, decided_at = ?, result = ? WHERE id = ?",
      decidedBy,
      now(),
      String(error).slice(0, 200),
      proposalId,
    );
    return { ok: false, error: "EXECUTION_FAILED" };
  }

  await run(
    "UPDATE agent_proposals SET status = 'executed', decided_by = ?, decided_at = ?, result = ? WHERE id = ?",
    decidedBy,
    now(),
    result,
    proposalId,
  );
  return { ok: true, result };
}

/* ------------------------------------------------------------------ */
/* Audit log readers                                                   */
/* ------------------------------------------------------------------ */

export interface RunRow {
  id: number;
  agent: string;
  trigger: string;
  actor: string;
  status: string;
  detail: string | null;
  context_rows: number;
  proposals: number;
  tokens_in: number;
  tokens_out: number;
  duration_ms: number;
  used_model: string | null;
  created_at: string;
}

export async function recentRuns(limit = 25): Promise<RunRow[]> {
  return await all<RunRow>(
    "SELECT * FROM agent_runs ORDER BY id DESC LIMIT ?",
    limit,
  );
}

export interface ProposalView extends ProposalRow {
  run_id: number;
  decided_by: string | null;
  decided_at: string | null;
  result: string | null;
  created_at: string;
}

/** One proposal, for a route that must check who is allowed to decide it. */
export async function proposalById(
  id: number,
): Promise<ProposalView | undefined> {
  return await get<ProposalView>(
    "SELECT * FROM agent_proposals WHERE id = ?",
    id,
  );
}

/** Everything filed by one person's submissions — their approval queue. */
export async function proposalsForOwner(
  ownerId: number,
  limit = 60,
): Promise<ProposalView[]> {
  return await all<ProposalView>(
    "SELECT * FROM agent_proposals WHERE owner_user_id = ? ORDER BY id DESC LIMIT ?",
    ownerId,
    limit,
  );
}

/**
 * A department head's queue: everything drafted for their people, whoever
 * submitted the source.
 */
export async function proposalsForReviewer(
  reviewerId: number,
  limit = 60,
): Promise<ProposalView[]> {
  return await all<ProposalView>(
    `SELECT * FROM agent_proposals
      WHERE reviewer_user_id = ? OR (reviewer_user_id IS NULL AND owner_user_id = ?)
      ORDER BY id DESC LIMIT ?`,
    reviewerId,
    reviewerId,
    limit,
  );
}

/** Whether this person is the one who must decide a given proposal. */
export function mayDecide(proposal: ProposalView, userId: number): boolean {
  if (proposal.reviewer_user_id) return proposal.reviewer_user_id === userId;
  return proposal.owner_user_id === userId;
}

export async function runsForOwner(
  ownerId: number,
  limit = 20,
): Promise<RunRow[]> {
  return await all<RunRow>(
    "SELECT * FROM agent_runs WHERE owner_user_id = ? ORDER BY id DESC LIMIT ?",
    ownerId,
    limit,
  );
}

export async function proposals(
  status: string | null,
  limit = 50,
): Promise<ProposalView[]> {
  return status
    ? await all<ProposalView>(
        "SELECT * FROM agent_proposals WHERE status = ? ORDER BY id DESC LIMIT ?",
        status,
        limit,
      )
    : await all<ProposalView>(
        "SELECT * FROM agent_proposals ORDER BY id DESC LIMIT ?",
        limit,
      );
}
