/**
 * The partnership path of TZ 6.2: nine stages in place of four statuses.
 * No database import — the list page, the card, the tests and the sweep
 * all read the same table.
 *
 * Each stage has an entry condition the TZ states, and three of them are
 * recognisable from records the platform already keeps: a company enters
 * the base (stage 1), a meeting is filed with it (stage 3), an agreement is
 * signed with it (stage 6, or 7 for a contract). Those moves are made for
 * the person; the others are theirs to make on the card.
 */

export const STAGES = [
  "NEW_CONTACT",
  "CONTACT",
  "MEETING",
  "PROPOSAL",
  "NEGOTIATION",
  "AGREEMENT",
  "ACTIVE",
  "MONITORING",
  "CLOSED",
] as const;
export type Stage = (typeof STAGES)[number];

export function isStage(value: unknown): value is Stage {
  return typeof value === "string" && (STAGES as readonly string[]).includes(value);
}

export function stageRank(stage: Stage): number {
  return STAGES.indexOf(stage);
}

/**
 * How many days a company may sit in a stage before it reads as stuck
 * ("Qotib qolgan", TZ 6.2). An opening proposal, changed in settings;
 * CLOSED never expires, and the two long-running stages get a year.
 */
export const DEFAULT_STAGE_LIMITS: Record<Stage, number> = {
  NEW_CONTACT: 14,
  CONTACT: 30,
  MEETING: 30,
  PROPOSAL: 30,
  NEGOTIATION: 60,
  AGREEMENT: 90,
  ACTIVE: 365,
  MONITORING: 365,
  CLOSED: 0,
};

/** Stored limits over the defaults, each a whole number of days (0 = never). */
export function mergeStageLimits(stored: unknown): Record<Stage, number> {
  const out = { ...DEFAULT_STAGE_LIMITS };
  if (!stored || typeof stored !== "object") return out;
  for (const stage of STAGES) {
    const value = Number((stored as Record<string, unknown>)[stage]);
    if (Number.isFinite(value) && value >= 0 && value <= 3650) out[stage] = Math.round(value);
  }
  return out;
}

/** The four old statuses, read as a point on the path. */
export function stageFromStatus(status: string): Stage {
  switch (status) {
    case "ACTIVE":
      return "ACTIVE";
    case "PAUSED":
      return "NEGOTIATION";
    case "ARCHIVED":
      return "CLOSED";
    default:
      return "NEW_CONTACT";
  }
}

/** The status every existing filter understands, written from the stage. */
export function statusFromStage(stage: Stage): "POTENTIAL" | "ACTIVE" | "ARCHIVED" {
  if (stage === "ACTIVE" || stage === "MONITORING") return "ACTIVE";
  if (stage === "CLOSED") return "ARCHIVED";
  return "POTENTIAL";
}

/**
 * Whole days between a stored instant and today. The platform writes
 * `YYYY-MM-DD HH:MM:SS` in UTC with no zone; a value that already carries
 * one (written by hand in SQL) is read as it is rather than refused.
 */
export function daysIn(since: string | null, today = new Date()): number | null {
  if (!since) return null;
  const zoned = /(?:Z|[+-]\d\d(?::?\d\d)?)$/.test(since);
  const iso = since.replace(" ", "T") + (since.length <= 10 ? "T00:00:00Z" : zoned ? "" : "Z");
  const start = Date.parse(iso);
  if (!Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((today.getTime() - start) / 86_400_000));
}

/** Past the stage's limit, when the stage has one. */
export function isStuck(
  stage: Stage,
  since: string | null,
  limits: Record<Stage, number> = DEFAULT_STAGE_LIMITS,
  today = new Date(),
): boolean {
  const limit = limits[stage];
  if (!limit) return false;
  const days = daysIn(since, today);
  return days !== null && days > limit;
}

/**
 * The stage a recorded event earns. A meeting lifts a company to MEETING
 * unless it is already further; a signed memorandum, letter of intent or
 * term sheet to AGREEMENT; a signed contract to ACTIVE.
 */
export function stageFor(event: "meeting" | "kelishuv" | "contract"): Stage {
  return event === "meeting" ? "MEETING" : event === "kelishuv" ? "AGREEMENT" : "ACTIVE";
}

/** Whether moving from `from` to `to` is forwards along the path. */
export function isAdvance(from: Stage, to: Stage): boolean {
  return stageRank(to) > stageRank(from);
}

export const VERIFICATIONS = ["NOT_CHECKED", "CHECKED", "FLAGGED"] as const;
export type Verification = (typeof VERIFICATIONS)[number];

export const ASSOCIATION_STATUSES = ["FAOL", "SUST", "TOXTATILGAN"] as const;
export type AssociationStatus = (typeof ASSOCIATION_STATUSES)[number];

export const KONTURS = ["GR", "BR", "FR", "PR"] as const;
export type Kontur = (typeof KONTURS)[number];
