import { all, get, now, tx } from "./pg";
import { PHASE_STATUS, type Phase } from "./project-passport";
import { addDaysTo, phaseAfter, tierOf, type Outcome } from "./signal-rules";
import { tierSettings } from "./settings";
import { remember } from "./knowledge/sources";

/**
 * Decision points, TZ 8.3. A project moves along its life cycle only when
 * somebody decides — continue, rework or stop — and the decision is kept
 * with who took it and why. The passport route refuses a phase change that
 * arrives without one, so the two cannot drift apart.
 */

export interface Decision {
  id: number;
  project_id: number;
  phase_from: Phase | null;
  phase_to: Phase | null;
  outcome: Outcome;
  note: string | null;
  decided_by: number | null;
  decided_by_name: string | null;
  decided_at: string;
}

export async function decisionsOf(projectId: number): Promise<Decision[]> {
  return await all<Decision>(
    `SELECT d.id, d.project_id, d.phase_from, d.phase_to, d.outcome, d.note, d.decided_by,
            u.full_name AS decided_by_name, d.decided_at
       FROM project_decisions d LEFT JOIN users u ON u.id = d.decided_by
      WHERE d.project_id = ? ORDER BY d.id DESC LIMIT 100`,
    projectId,
  );
}

export interface DecisionInput {
  outcome: Outcome;
  note?: string | null;
  /** The phase to land in, when the outcome's default is not the one meant. */
  phaseTo?: Phase | null;
  /** The next decision date; by default the tier's rhythm from today. */
  nextDecisionOn?: string | null;
}

/**
 * Writes the decision and moves the project: the phase it lands in, the
 * older status that follows the phase, the review stamp and the next
 * decision date. One transaction — a decision without its move, or a move
 * without its decision, is exactly what the TZ forbids.
 */
export async function recordDecision(
  projectId: number,
  input: DecisionInput,
  userId: number,
): Promise<{ id: number; phase: Phase | null; next_decision_on: string }> {
  const project = await get<{ phase: Phase | null; tier: string | null }>(
    "SELECT phase, tier FROM loyihalar WHERE id = ?",
    projectId,
  );
  if (!project) throw new Error("NOT_FOUND");
  const to = phaseAfter(input.outcome, project.phase, input.phaseTo ?? null);
  const settings = await tierSettings();
  const stamp = now();
  const today = stamp.slice(0, 10);
  const next = input.nextDecisionOn ?? addDaysTo(today, settings[tierOf(project.tier)].reviewDays);

  const id = await tx(async (q) => {
    const newId = await q.insert(
      `INSERT INTO project_decisions (project_id, phase_from, phase_to, outcome, note, decided_by, decided_at)
       VALUES (?,?,?,?,?,?,?)`,
      projectId,
      project.phase,
      to,
      input.outcome,
      input.note?.trim() || null,
      userId,
      stamp,
    );
    await q.run(
      `UPDATE loyihalar SET phase = ?, status = COALESCE(?, status), last_reviewed_at = ?, next_decision_on = ? WHERE id = ?`,
      to,
      to ? PHASE_STATUS[to] : null,
      stamp,
      next,
      projectId,
    );
    return newId;
  });
  void remember("project", projectId);
  return { id, phase: to, next_decision_on: next };
}

/** A review that changed nothing: the rhythm was kept, the date moves on. */
export async function markReviewed(projectId: number): Promise<string> {
  const project = await get<{ tier: string | null }>("SELECT tier FROM loyihalar WHERE id = ?", projectId);
  if (!project) throw new Error("NOT_FOUND");
  const settings = await tierSettings();
  const stamp = now();
  const next = addDaysTo(stamp.slice(0, 10), settings[tierOf(project.tier)].reviewDays);
  await tx(async (q) => {
    await q.run("UPDATE loyihalar SET last_reviewed_at = ?, next_decision_on = ? WHERE id = ?", stamp, next, projectId);
  });
  return next;
}
