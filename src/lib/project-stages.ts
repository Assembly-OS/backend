import { actingAs } from "./archive";
import { notify } from "./notifications";
import { seesEverything } from "./oversight";
import { all, get, now, run, tx } from "./pg";
import type { User } from "./types";
import { str } from "./validate";
import { HELP_STATUSES, isLate, type HelpStatus } from "./work-schedule";

export {
  HELP_STATUSES,
  daysLate,
  isLate,
  stageView,
  type HelpStatus,
  type StageView,
} from "./work-schedule";

/**
 * A project's work schedule, block 1.4 of the rebuild TZ: each item's plan and
 * its facts side by side, the reason when it fell behind, and the help it
 * asked the Assembly for.
 */

export interface StageRow {
  id: number;
  project_id: number;
  position: number;
  name: string;
  plan_start: string;
  plan_end: string;
  fact_start: string | null;
  fact_end: string | null;
  progress: number;
  delay_reason: string | null;
  help_needed: string | null;
  help_status: HelpStatus | null;
  help_round: number;
  help_requested_by: number | null;
  requester_name: string | null;
  help_requested_at: string | null;
  updated_at: string | null;
  updater_name: string | null;
}

/** Every item of a project's schedule, in the order it was laid out. */
export async function stagesOf(projectId: number): Promise<StageRow[]> {
  return await all<StageRow>(
    `SELECT s.*, r.full_name AS requester_name, u.full_name AS updater_name
       FROM project_stages s
       LEFT JOIN users r ON r.id = s.help_requested_by
       LEFT JOIN users u ON u.id = s.updated_by
      WHERE s.project_id = ?
      ORDER BY s.position, s.id`,
    projectId,
  );
}

/* ------------------------------------------------------------------ */
/* Reading what the editor sent                                        */
/* ------------------------------------------------------------------ */

export interface StageInput {
  id: number | null;
  name: string;
  plan_start: string;
  plan_end: string;
  fact_start: string | null;
  fact_end: string | null;
  progress: number;
  delay_reason: string | null;
  help_needed: string | null;
  help_status: HelpStatus | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = (value: unknown) => {
  const text = str(value, 10);
  return text && DAY.test(text) ? text : null;
};

/**
 * Checks the schedule the editor sent, line by line.
 *
 * Unlike a meeting or an agreement, here the TZ is not asking to be judged
 * leniently. An item without its planned dates cannot be compared with
 * anything, so it is refused; and an item behind its plan without a reason
 * is refused, because that reason is the one thing the TZ calls compulsory in
 * the whole table — it is what the next leader reads to learn why the work
 * stopped. Each refusal names the line, so the editor can put the cursor on it.
 *
 * An actual end date means the item is finished, so it carries a hundred per
 * cent: a row reading "ended on the 13th, 60 % done" would say two things.
 */
export function readStages(
  body: Record<string, unknown>,
  today: string,
): { ok: true; rows: StageInput[] } | { ok: false; error: string; row: number } {
  const raw = Array.isArray(body.stages) ? body.stages.slice(0, 40) : [];
  const rows: StageInput[] = [];

  for (const [index, entry] of raw.entries()) {
    const item = entry as Record<string, unknown>;
    const name = str(item.name, 200);
    const planStart = day(item.plan_start);
    const planEnd = day(item.plan_end);
    // A line added and left completely empty is not an item.
    if (!name && !planStart && !planEnd) continue;
    const row = index + 1;
    if (!name) return { ok: false, error: "NAME_REQUIRED", row };
    if (!planStart || !planEnd) return { ok: false, error: "PLAN_REQUIRED", row };
    if (planEnd < planStart) return { ok: false, error: "BAD_PLAN", row };

    const factStart = day(item.fact_start);
    const factEnd = day(item.fact_end);
    if (factStart && factEnd && factEnd < factStart)
      return { ok: false, error: "BAD_FACT", row };

    const n = Number(item.progress);
    let progress = Number.isFinite(n) ? Math.round(Math.min(100, Math.max(0, n))) : 0;
    if (factEnd) progress = 100;

    const input: StageInput = {
      id: typeof item.id === "number" && item.id > 0 ? item.id : null,
      name,
      plan_start: planStart,
      plan_end: planEnd,
      fact_start: factStart,
      fact_end: factEnd,
      progress,
      delay_reason: str(item.delay_reason, 1000),
      help_needed: str(item.help_needed, 1000),
      help_status: HELP_STATUSES.includes(item.help_status as HelpStatus)
        ? (item.help_status as HelpStatus)
        : null,
    };
    if (isLate(input, today) && !input.delay_reason)
      return { ok: false, error: "DELAY_REASON", row };
    rows.push(input);
  }
  return { ok: true, rows };
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/** What the requester is told when the Assembly answers. Stored in Uzbek,
 *  as every server-written notification is. */
const ANSWER_TEXT: Record<Exclude<HelpStatus, "REQUESTED">, string> = {
  IN_REVIEW: "Yordam so'rovi ko'rib chiqilmoqda",
  GIVEN: "Yordam berildi",
  REFUSED: "Yordam so'rovi rad etildi",
};

/**
 * Who hears that an item needs help: the project's leader and deputy, when
 * they are on the staff and are not the one asking. When that leaves nobody —
 * both named from outside the Assembly, or the leader asking on the project's
 * behalf — the chairman's side hears it instead, so a request is never
 * addressed to nobody.
 */
async function helpRecipients(projectId: number, actorId: number): Promise<number[]> {
  const project = await get<{ owner_id: number | null; deputy_id: number | null }>(
    "SELECT owner_id, deputy_id FROM loyihalar WHERE id = ?",
    projectId,
  );
  const named = [project?.owner_id, project?.deputy_id].filter(
    (id): id is number => typeof id === "number" && id !== actorId,
  );
  if (named.length) return [...new Set(named)];
  const everyone = await all<User>("SELECT * FROM users WHERE is_active = 1");
  return everyone.filter((u) => seesEverything(u) && u.id !== actorId).map((u) => u.id);
}

/**
 * Makes the schedule say exactly what the editor sent.
 *
 * Items left off are deleted inside a transaction under the editor's name, so
 * the archive records who removed them. Every other line is inserted or
 * updated in its new position.
 *
 * Help is where the lines differ. Writing into "help needed" on an item that
 * had no open request starts a new request: a new round, status REQUESTED,
 * and the leaders are told. Changing the status of a request is an answer,
 * taken only from somebody who may answer for the Assembly (`mayAnswer`), and
 * the person who asked is told. Clearing the text closes the request.
 */
export async function saveStages(
  projectId: number,
  rows: StageInput[],
  actor: User,
  mayAnswer: boolean,
): Promise<void> {
  const existing = await all<StageRow>(
    "SELECT * FROM project_stages WHERE project_id = ?",
    projectId,
  );
  const byId = new Map(existing.map((row) => [row.id, row]));
  const kept = new Set(rows.map((row) => row.id).filter((id): id is number => id !== null));

  const dropped = existing.filter((row) => !kept.has(row.id));
  if (dropped.length) {
    await tx(async (q) => {
      await actingAs(q, actor.id);
      for (const row of dropped) await q.run("DELETE FROM project_stages WHERE id = ?", row.id);
    });
  }

  const project = await get<{ code: string }>("SELECT code FROM loyihalar WHERE id = ?", projectId);
  const stamp = now();
  const told: { stageId: number; name: string; round: number; text: string }[] = [];
  const answered: { stageId: number; name: string; round: number; to: number; status: HelpStatus }[] = [];

  for (const [index, row] of rows.entries()) {
    const before = row.id !== null ? byId.get(row.id) : undefined;

    let helpStatus: HelpStatus | null = before?.help_status ?? null;
    let round = before?.help_round ?? 0;
    let requestedBy = before?.help_requested_by ?? null;
    let requestedAt = before?.help_requested_at ?? null;

    if (!row.help_needed) {
      // The text cleared: the request is closed. The round count stays, so
      // a later request is still a new one.
      helpStatus = null;
      requestedBy = null;
      requestedAt = null;
    } else {
      // A request still waiting on the Assembly, reworded, is the same
      // request — nobody is told twice. One that was answered, asked again in
      // new words, is a new request. So is the first one on an item.
      const waiting = helpStatus === "REQUESTED" || helpStatus === "IN_REVIEW";
      const askedBefore = Boolean(before?.help_needed) && helpStatus !== null;
      const askedAgain = askedBefore && !waiting && before?.help_needed !== row.help_needed;
      if (!askedBefore || askedAgain) {
        round += 1;
        helpStatus = "REQUESTED";
        requestedBy = actor.id;
        requestedAt = stamp;
      } else if (mayAnswer && row.help_status && row.help_status !== helpStatus) {
        helpStatus = row.help_status;
      }
    }

    const values = [
      index + 1,
      row.name,
      row.plan_start,
      row.plan_end,
      row.fact_start,
      row.fact_end,
      row.progress,
      row.delay_reason,
      row.help_needed,
      helpStatus,
      round,
      requestedBy,
      requestedAt,
      actor.id,
      stamp,
    ] as const;

    let stageId: number;
    if (before) {
      await run(
        `UPDATE project_stages
            SET position = ?, name = ?, plan_start = ?, plan_end = ?, fact_start = ?,
                fact_end = ?, progress = ?, delay_reason = ?, help_needed = ?,
                help_status = ?, help_round = ?, help_requested_by = ?,
                help_requested_at = ?, updated_by = ?, updated_at = ?
          WHERE id = ?`,
        ...values,
        before.id,
      );
      stageId = before.id;
    } else {
      stageId = (await get<{ id: number }>(
        `INSERT INTO project_stages
           (position, name, plan_start, plan_end, fact_start, fact_end, progress,
            delay_reason, help_needed, help_status, help_round, help_requested_by,
            help_requested_at, updated_by, updated_at, project_id, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
        ...values,
        projectId,
        actor.id,
      ))!.id;
    }

    if (helpStatus === "REQUESTED" && round !== (before?.help_round ?? 0))
      told.push({ stageId, name: row.name, round, text: row.help_needed! });
    else if (
      helpStatus &&
      helpStatus !== "REQUESTED" &&
      helpStatus !== before?.help_status &&
      requestedBy &&
      requestedBy !== actor.id
    )
      answered.push({ stageId, name: row.name, round, to: requestedBy, status: helpStatus });
  }

  // Told after the writes, so a notification never points at a row that a
  // failed save did not keep.
  const href = `/projects/${projectId}`;
  const code = project?.code ?? "";
  if (told.length) {
    const recipients = await helpRecipients(projectId, actor.id);
    for (const request of told)
      for (const userId of recipients)
        await notify({
          userId,
          kind: "project",
          title: `${code} · ${request.name}`,
          body: request.text,
          href,
          entity: `stage_help_${request.round}`,
          entityId: request.stageId,
          push: true,
        });
  }
  for (const answer of answered)
    await notify({
      userId: answer.to,
      kind: "project",
      title: `${code} · ${answer.name}`,
      body: ANSWER_TEXT[answer.status as Exclude<HelpStatus, "REQUESTED">],
      href,
      entity: `stage_help_${answer.round}_${answer.status}`,
      entityId: answer.stageId,
      push: true,
    });
}
