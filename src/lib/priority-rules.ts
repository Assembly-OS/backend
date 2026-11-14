import type { Priority } from "./types";

/**
 * The priority limits of TZ block 3.5, as a pure rule.
 *
 * The audit found "Yuqori" on 62% of assignments and "Past" on none: when
 * most things are urgent, urgency stops meaning anything. So critical work is
 * capped across the whole Assembly, and a manager's "high" is capped as a
 * share of what that manager has open.
 *
 * No database import: the assignment form uses the same function to disable
 * the options the server would refuse, so the two cannot disagree.
 */

/** Open critical assignments allowed across the whole system at once. */
export const KRITIK_LIMIT = 5;

/** The share of one manager's open assignments that may be "high". */
export const YUQORI_SHARE = 0.25;

/** What the rule needs to know, counted over open work only. */
export interface PriorityRoom {
  /** Open critical assignments, everyone's. */
  kritikOpen: number;
  /** Open assignments this author has handed out. */
  authorOpen: number;
  /** Of those, how many are "high". */
  authorHigh: number;
}

export type PriorityRefusal = "KRITIK_LIMIT" | "YUQORI_LIMIT";

/**
 * Why one more assignment of `priority` would break a limit, or null.
 *
 * The "high" share is judged with the new assignment counted in, and a
 * manager's first "high" is always allowed: with three assignments open, a
 * quarter rounds down to nothing, and a rule that forbids anyone with a small
 * workload from ever marking something high is not the rule the TZ wrote.
 */
export function priorityRefusal(
  priority: Priority,
  room: PriorityRoom,
): PriorityRefusal | null {
  if (priority === "KRITIK" && room.kritikOpen >= KRITIK_LIMIT) return "KRITIK_LIMIT";
  if (priority === "YUQORI") {
    const total = room.authorOpen + 1;
    const high = room.authorHigh + 1;
    if (high > Math.max(1, Math.floor(total * YUQORI_SHARE))) return "YUQORI_LIMIT";
  }
  return null;
}
