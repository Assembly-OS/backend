/**
 * A project's work schedule, block 1.4 of the rebuild TZ, with nothing that
 * touches the database — the editor is a client component and the tests import
 * it directly.
 */

/** Where a request for the Assembly's help stands. */
export const HELP_STATUSES = ["REQUESTED", "IN_REVIEW", "GIVEN", "REFUSED"] as const;
export type HelpStatus = (typeof HELP_STATUSES)[number];

export interface StageDates {
  plan_start: string;
  plan_end: string;
  fact_start: string | null;
  fact_end: string | null;
  progress: number;
}

/** Whole days from `a` to `b`, calendar dates 'YYYY-MM-DD', b − a. */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * Whether an item has fallen behind its plan — the TZ's "the fact is behind
 * the plan", which is what makes a reason for the delay compulsory.
 *
 * Behind means the finish: done after the planned end, or not done and the
 * planned end already past. A late start that is made up by the end is not a
 * delay anyone needs to explain, and asking for a reason every time a start
 * slips a day would teach people to type anything into the box.
 */
export function isLate(stage: StageDates, today: string): boolean {
  if (stage.fact_end) return stage.fact_end > stage.plan_end;
  return stage.plan_end < today && stage.progress < 100;
}

/** How many days behind, for display; zero when on time. */
export function daysLate(stage: StageDates, today: string): number {
  if (!isLate(stage, today)) return 0;
  return daysBetween(stage.plan_end, stage.fact_end ?? today);
}

/**
 * What a reader sees for an item.
 *
 * DONE once it has an actual end or reached a hundred per cent — finished
 * late is still finished, and the days it ran over are shown beside it rather
 * than keeping it red for good. LATE when unfinished and past its planned end;
 * ACTIVE once started; PLANNED before that.
 */
export type StageView = "DONE" | "LATE" | "ACTIVE" | "PLANNED";

export function stageView(stage: StageDates, today: string): StageView {
  if (stage.fact_end || stage.progress >= 100) return "DONE";
  if (isLate(stage, today)) return "LATE";
  if (stage.fact_start || stage.progress > 0 || stage.plan_start <= today) return "ACTIVE";
  return "PLANNED";
}
