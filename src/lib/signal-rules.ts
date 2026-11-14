import { PHASES, TIERS, type Phase, type Tier } from "./project-passport";

/**
 * The rules of TZ 7.5 and 8.2–8.4 with nothing that touches the database:
 * how a tier is reviewed, when a project reads as inactive, red or without
 * a decision, which outcome moves a project where, and what the chairman's
 * home page counts. Pure, so the tests read them directly and the client
 * components may import them.
 */

/* ------------------------------------------------------------------ */
/* Tiers (8.2)                                                         */
/* ------------------------------------------------------------------ */

export interface TierRule {
  /** Days between reviews: weekly, monthly, quarterly in the TZ. */
  reviewDays: number;
  /** The share of red projects a cluster may carry at this tier, percent. */
  redShareMax: number;
}
export type TierSettings = Record<Tier, TierRule>;

export const TIER_DEFAULTS: TierSettings = {
  FLAGSHIP: { reviewDays: 7, redShareMax: 15 },
  ACTIVE: { reviewDays: 30, redShareMax: 30 },
  PIPELINE: { reviewDays: 90, redShareMax: 100 },
};

const int = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : fallback;
};

export function mergeTierSettings(stored: unknown): TierSettings {
  const out: TierSettings = {
    FLAGSHIP: { ...TIER_DEFAULTS.FLAGSHIP },
    ACTIVE: { ...TIER_DEFAULTS.ACTIVE },
    PIPELINE: { ...TIER_DEFAULTS.PIPELINE },
  };
  if (!stored || typeof stored !== "object") return out;
  for (const tier of TIERS) {
    const rule = (stored as Record<string, Record<string, unknown>>)[tier];
    if (!rule || typeof rule !== "object") continue;
    out[tier].reviewDays = int(rule.reviewDays, 1, 365, out[tier].reviewDays);
    out[tier].redShareMax = int(rule.redShareMax, 0, 100, out[tier].redShareMax);
  }
  return out;
}

/** A project with no tier yet is watched like the pipeline: least often. */
export function tierOf(value: string | null | undefined): Tier {
  return TIERS.includes(value as Tier) ? (value as Tier) : "PIPELINE";
}

/* ------------------------------------------------------------------ */
/* Signals (7.5)                                                       */
/* ------------------------------------------------------------------ */

export interface SignalSettings {
  /** Days without a record before a project reads as inactive, per tier. */
  inactiveDays: Record<Tier, number>;
  /** A contour's share of open work below this percent is an imbalance. */
  konturMinShare: number;
  /** Leading this many flagship or active projects at once is an overload. */
  overloadProjects: number;
  /** Overdue share of a project's open tasks, percent, that turns it red. */
  redTaskShare: number;
}

export const SIGNAL_DEFAULTS: SignalSettings = {
  inactiveDays: { FLAGSHIP: 14, ACTIVE: 30, PIPELINE: 90 },
  konturMinShare: 10,
  overloadProjects: 2,
  redTaskShare: 30,
};

export function mergeSignalSettings(stored: unknown): SignalSettings {
  const out: SignalSettings = { ...SIGNAL_DEFAULTS, inactiveDays: { ...SIGNAL_DEFAULTS.inactiveDays } };
  if (!stored || typeof stored !== "object") return out;
  const s = stored as Record<string, unknown>;
  if (s.inactiveDays && typeof s.inactiveDays === "object")
    for (const tier of TIERS)
      out.inactiveDays[tier] = int(
        (s.inactiveDays as Record<string, unknown>)[tier],
        1,
        365,
        out.inactiveDays[tier],
      );
  out.konturMinShare = int(s.konturMinShare, 0, 100, out.konturMinShare);
  out.overloadProjects = int(s.overloadProjects, 1, 20, out.overloadProjects);
  out.redTaskShare = int(s.redTaskShare, 1, 100, out.redTaskShare);
  return out;
}

/* ------------------------------------------------------------------ */
/* The AI queue (7.1)                                                  */
/* ------------------------------------------------------------------ */

export const SEVERITIES = ["P1", "P2", "P3", "P4"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface AiSettings {
  /** Off by default (TZ 7.1): the chairman's side switches it on. */
  autoApprove: boolean;
  /** Proposals at this severity or lower risk are approved on their own. */
  autoApproveMaxSeverity: Severity;
  /** A proposal nobody looked at for this many days is archived. */
  expireDays: number;
}

export const AI_DEFAULTS: AiSettings = {
  autoApprove: false,
  autoApproveMaxSeverity: "P4",
  expireDays: 30,
};

export function mergeAiSettings(stored: unknown): AiSettings {
  const out = { ...AI_DEFAULTS };
  if (!stored || typeof stored !== "object") return out;
  const s = stored as Record<string, unknown>;
  if (typeof s.autoApprove === "boolean") out.autoApprove = s.autoApprove;
  if ((SEVERITIES as readonly string[]).includes(String(s.autoApproveMaxSeverity)))
    out.autoApproveMaxSeverity = s.autoApproveMaxSeverity as Severity;
  out.expireDays = int(s.expireDays, 1, 365, out.expireDays);
  return out;
}

/** P1 is the loudest. A proposal is low risk when its number is at least the limit's. */
export function autoApprovable(severity: string, settings: AiSettings): boolean {
  if (!settings.autoApprove) return false;
  const rank = SEVERITIES.indexOf(severity as Severity);
  const limit = SEVERITIES.indexOf(settings.autoApproveMaxSeverity);
  return rank >= 0 && rank >= limit;
}

/* ------------------------------------------------------------------ */
/* Decision points (8.3)                                               */
/* ------------------------------------------------------------------ */

export const OUTCOMES = ["CONTINUE", "REWORK", "STOP"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export function isOutcome(value: unknown): value is Outcome {
  return typeof value === "string" && (OUTCOMES as readonly string[]).includes(value);
}

/** The life cycle the decisions walk; FROZEN sits beside it, not on it. */
export const LIFE_CYCLE: Phase[] = ["CONCEPT", "FEASIBILITY", "PREPARATION", "EXECUTION", "MONITORING", "CLOSED"];

export function nextPhase(from: Phase | null): Phase | null {
  if (!from) return "CONCEPT";
  const at = LIFE_CYCLE.indexOf(from);
  if (at < 0) return null; // frozen: a decision to continue names its phase
  return LIFE_CYCLE[at + 1] ?? null;
}

/**
 * Where an outcome leaves the project: continue moves it one phase on,
 * rework keeps it where it is, stop freezes it. A phase named explicitly
 * wins over the default — a frozen project continuing has to say where.
 */
export function phaseAfter(outcome: Outcome, from: Phase | null, named?: Phase | null): Phase | null {
  if (named && PHASES.includes(named)) return named;
  if (outcome === "CONTINUE") return nextPhase(from);
  if (outcome === "STOP") return "FROZEN";
  return from;
}

/* ------------------------------------------------------------------ */
/* Calendar arithmetic on YYYY-MM-DD                                   */
/* ------------------------------------------------------------------ */

const DAY = 86_400_000;

function dayStamp(value: string): number {
  const [y, m, d] = value.slice(0, 10).split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDaysTo(day: string, days: number): string {
  return new Date(dayStamp(day) + days * DAY).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayStamp(to) - dayStamp(from)) / DAY);
}

/** The day the next review is due, from the last one or the project's birth. */
export function reviewDueOn(
  lastReviewed: string | null,
  createdAt: string,
  tier: string | null,
  settings: TierSettings,
): string {
  return addDaysTo(lastReviewed ?? createdAt, settings[tierOf(tier)].reviewDays);
}

/* ------------------------------------------------------------------ */
/* A project's health (8.4)                                            */
/* ------------------------------------------------------------------ */

export interface HealthFlags {
  /** No record for longer than the tier allows. */
  inactive: boolean;
  /** The decision date passed with no decision taken. */
  decisionOverdue: boolean;
  /** The tier's review rhythm was missed. */
  reviewOverdue: boolean;
  /** Overdue work or a late stage past the limit. */
  red: boolean;
  /** Nobody leads it. */
  noOwner: boolean;
  /** Leader, deputy or the partnership shares missing. */
  passportIncomplete: boolean;
}

export type Rag = "RED" | "AMBER" | "GREEN";

/**
 * Red is what needs the chairman: nobody in charge, a decision not taken,
 * or work visibly failing. Amber is drift: quiet, unreviewed, unfinished
 * paperwork. Everything else is green and stays off his screen.
 */
export function projectRag(flags: HealthFlags): Rag {
  if (flags.noOwner || flags.decisionOverdue || flags.red) return "RED";
  if (flags.inactive || flags.reviewOverdue || flags.passportIncomplete) return "AMBER";
  return "GREEN";
}

/** Whether a phase is one a live project sits in. */
export function isLivePhase(phase: string | null): boolean {
  return phase !== "CLOSED" && phase !== "FROZEN";
}

/** The TZ's "red share must not exceed" test, per tier. */
export function redShareOk(red: number, total: number, tier: string | null, settings: TierSettings): boolean {
  if (total === 0) return true;
  return (red * 100) / total <= settings[tierOf(tier)].redShareMax;
}

/**
 * The share of open work each department carries, and which contours are
 * starved. Shares are over every department, as the TZ's own example counts
 * them ("AI Lab 49% va PR 34%"); the alarm is raised only for the four
 * contours that bring capital, partners and markets.
 */
export function konturShares(
  counts: Record<string, number>,
  departments: readonly string[],
  minShare: number,
  watched: readonly string[] = departments,
): { department: string; open: number; share: number; low: boolean }[] {
  const total = departments.reduce((sum, d) => sum + (counts[d] ?? 0), 0);
  return departments.map((department) => {
    const open = counts[department] ?? 0;
    const share = total ? Math.round((open * 100) / total) : 0;
    return { department, open, share, low: total > 0 && watched.includes(department) && share < minShare };
  });
}
