import type { Role } from "./types";

/**
 * The KPI model of TZ block 5, as rules — no database import, so the pages,
 * the tests and the settings form all read the same arithmetic.
 *
 * Two halves, as the TZ draws them. **Harakat** (effort) is what the person
 * controls entirely: deadline work finished on time, the reporting rhythm on
 * open-ended work, how much of what they hand in comes back, and whether the
 * meetings they sat in were written up. **Natija** (result) is what the
 * Assembly exists for and only partly depends on them: agreements signed,
 * capital attracted, new partners, projects moved to the next phase. Each
 * half is a percentage; the role's ratio weighs them into one score, and the
 * score reads as a traffic light.
 *
 * Every number the model uses is counted from records that already exist —
 * tasks, the progress journal, meetings, agreements, the CRM, the project
 * passport and the audit journal. Nothing is typed in by hand (TZ 5: "natija
 * bloki kelishuv va CRM'dan avtomatik to'ldiriladi, qo'lda emas").
 *
 * The ratios, the RAG thresholds, the two limits and the result targets are
 * **settings**, not constants: the TZ gives the ratios as an opening proposal
 * for the customer to confirm, and the targets below are this implementation's
 * opening proposal in the same spirit. The chairman edits them on the KPI
 * page; what is stored overrides what is written here.
 */

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

export interface Ratio {
  /** Weight of the effort half, in percent. */
  action: number;
  /** Weight of the result half, in percent. The two sum to 100. */
  result: number;
}

/** The result counts a role is expected to reach in one month. */
export interface Targets {
  /** Agreements (MOU, LOI, term sheet, contract) signed, as responsible. */
  agreements: number;
  /** Commitments to partners closed as done, as owner. */
  obligations: number;
  /** Companies added to the CRM, as owner. */
  partners: number;
  /** Projects led (owner or deputy) that moved to a later phase. */
  phases: number;
  /** Contracts signed, as responsible — export, technology transfer. */
  contracts: number;
}

export interface KpiSettings {
  ratios: Record<Role, Ratio>;
  rag: {
    /** At or above: green. */
    green: number;
    /** At or above (and below green): amber. Below: red. */
    amber: number;
  };
  limits: {
    /** Share of deadline work allowed to be late, in percent (TZ 5.3). */
    lateShare: number;
    /** Share of open-ended work allowed to be silent, in percent (TZ 5.3). */
    silentShare: number;
  };
  targets: Record<Role, Targets>;
}

/** TZ 5.2, row by row; roles the table does not name take the nearest row. */
const RATIOS: Record<Role, Ratio> = {
  RAIS: { action: 50, result: 50 },
  KLASTER_RAHBARI: { action: 30, result: 70 },
  BOLIM_RAHBARI: { action: 50, result: 50 },
  LOYIHA_RAHBARI: { action: 40, result: 60 },
  AI_LAB: { action: 50, result: 50 },
  ISHCHI: { action: 70, result: 30 },
  TASHQI_LOYIHA_RAHBARI: { action: 40, result: 60 },
  UYUSHMA_RAISI: { action: 50, result: 50 },
  UYUSHMA_VAKILI: { action: 50, result: 50 },
};

/**
 * Opening proposal for monthly result targets. A zero means the figure is
 * shown but not scored for that role — an employee is not marked down for
 * signing no agreements, because signing them is not his job.
 */
const TARGETS: Record<Role, Targets> = {
  RAIS: { agreements: 0, obligations: 0, partners: 0, phases: 0, contracts: 0 },
  KLASTER_RAHBARI: { agreements: 2, obligations: 0, partners: 2, phases: 2, contracts: 1 },
  BOLIM_RAHBARI: { agreements: 1, obligations: 3, partners: 2, phases: 0, contracts: 0 },
  LOYIHA_RAHBARI: { agreements: 1, obligations: 2, partners: 1, phases: 1, contracts: 0 },
  AI_LAB: { agreements: 0, obligations: 2, partners: 0, phases: 0, contracts: 0 },
  ISHCHI: { agreements: 0, obligations: 2, partners: 1, phases: 0, contracts: 0 },
  TASHQI_LOYIHA_RAHBARI: { agreements: 0, obligations: 0, partners: 0, phases: 1, contracts: 0 },
  UYUSHMA_RAISI: { agreements: 0, obligations: 0, partners: 0, phases: 0, contracts: 0 },
  UYUSHMA_VAKILI: { agreements: 0, obligations: 0, partners: 1, phases: 0, contracts: 0 },
};

export const DEFAULT_SETTINGS: KpiSettings = {
  ratios: RATIOS,
  rag: { green: 80, amber: 60 },
  limits: { lateShare: 15, silentShare: 20 },
  targets: TARGETS,
};

export const TARGET_KEYS = ["agreements", "obligations", "partners", "phases", "contracts"] as const;
export type TargetKey = (typeof TARGET_KEYS)[number];

/**
 * Stored settings over the defaults, field by field, with every number
 * checked: a setting file edited by hand or by an older form must not be
 * able to make a ratio sum to 140 or a threshold negative.
 */
export function mergeSettings(stored: unknown): KpiSettings {
  const base = structuredClone(DEFAULT_SETTINGS);
  if (!stored || typeof stored !== "object") return base;
  const input = stored as Partial<Record<keyof KpiSettings, unknown>>;

  const pct = (value: unknown, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : fallback;
  };
  const count = (value: unknown, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 && n <= 1000 ? Math.round(n) : fallback;
  };

  if (input.ratios && typeof input.ratios === "object") {
    for (const role of Object.keys(base.ratios) as Role[]) {
      const row = (input.ratios as Record<string, unknown>)[role];
      if (!row || typeof row !== "object") continue;
      const action = pct((row as Ratio).action, base.ratios[role].action);
      base.ratios[role] = { action, result: 100 - action };
    }
  }
  if (input.rag && typeof input.rag === "object") {
    const rag = input.rag as Partial<KpiSettings["rag"]>;
    const green = pct(rag.green, base.rag.green);
    const amber = Math.min(pct(rag.amber, base.rag.amber), green);
    base.rag = { green, amber };
  }
  if (input.limits && typeof input.limits === "object") {
    const limits = input.limits as Partial<KpiSettings["limits"]>;
    base.limits = {
      lateShare: pct(limits.lateShare, base.limits.lateShare),
      silentShare: pct(limits.silentShare, base.limits.silentShare),
    };
  }
  if (input.targets && typeof input.targets === "object") {
    for (const role of Object.keys(base.targets) as Role[]) {
      const row = (input.targets as Record<string, unknown>)[role];
      if (!row || typeof row !== "object") continue;
      for (const key of TARGET_KEYS)
        base.targets[role][key] = count((row as Partial<Targets>)[key], base.targets[role][key]);
    }
  }
  return base;
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

/** One effort component: how many went right, out of how many counted. */
export interface Fraction {
  good: number;
  total: number;
}

/** The four effort components of TZ 5.1. */
export interface ActionInput {
  /** Deadline work due in the period, finished on time vs late. */
  onTime: Fraction;
  /** Open-ended work in hand, reporting on rhythm vs silent. */
  reporting: Fraction;
  /** Hand-ins approved vs sent back for rework. */
  rework: Fraction;
  /** Meetings sat in, written up completely vs incomplete. */
  meetings: Fraction;
}

export type ActionKey = keyof ActionInput;
export const ACTION_KEYS: ActionKey[] = ["onTime", "reporting", "rework", "meetings"];

/**
 * A component's percentage, or null when nothing was counted: a person with
 * no deadline work this month is not 0% on time, the question does not arise.
 */
export function fractionPercent(fraction: Fraction): number | null {
  if (fraction.total <= 0) return null;
  return Math.round((100 * fraction.good) / fraction.total);
}

/**
 * The effort score: the mean of the components that apply. Equal weights,
 * because the TZ lists the four side by side and weighting them would be a
 * decision nobody has taken.
 */
export function scoreAction(input: ActionInput): number | null {
  const parts = ACTION_KEYS.map((key) => fractionPercent(input[key])).filter(
    (value): value is number => value !== null,
  );
  if (parts.length === 0) return null;
  return Math.round(parts.reduce((sum, value) => sum + value, 0) / parts.length);
}

/** What was actually achieved in the period, per target. */
export type ResultActuals = Record<TargetKey, number>;

/**
 * Open-ended work with a stated goal: the latest figure against the goal,
 * already as a share (0..1), one per task.
 */
export interface GoalProgress {
  taskId: number;
  code: string;
  title: string;
  target: number;
  latest: number | null;
  unit: string | null;
}

/**
 * The result score: each target with a non-zero goal contributes
 * min(1, actual / goal); each open-ended goal contributes its progress; the
 * score is the mean, in percent. Null when the role has no targets and the
 * person has no goals — then the score is the effort score alone, and the
 * card says so.
 */
export function scoreResult(
  actuals: ResultActuals,
  targets: Targets,
  goals: GoalProgress[],
): number | null {
  const shares: number[] = [];
  for (const key of TARGET_KEYS) {
    if (targets[key] > 0) shares.push(Math.min(1, actuals[key] / targets[key]));
  }
  for (const goal of goals) {
    if (goal.target > 0) shares.push(Math.min(1, Math.max(0, goal.latest ?? 0) / goal.target));
  }
  if (shares.length === 0) return null;
  return Math.round((100 * shares.reduce((sum, value) => sum + value, 0)) / shares.length);
}

/** Effort and result weighed by the role's ratio. */
export function combine(action: number | null, result: number | null, ratio: Ratio): number | null {
  if (action === null && result === null) return null;
  if (result === null) return action;
  if (action === null) return result;
  return Math.round((action * ratio.action + result * ratio.result) / 100);
}

export type Rag = "GREEN" | "AMBER" | "RED";

export function ragOf(score: number | null, rag: KpiSettings["rag"]): Rag | null {
  if (score === null) return null;
  if (score >= rag.green) return "GREEN";
  if (score >= rag.amber) return "AMBER";
  return "RED";
}

/** Mean of the scores that exist, for a department, a project, a cluster. */
export function meanScore(scores: (number | null)[]): number | null {
  const real = scores.filter((value): value is number => value !== null);
  if (real.length === 0) return null;
  return Math.round(real.reduce((sum, value) => sum + value, 0) / real.length);
}

/* ------------------------------------------------------------------ */
/* Periods                                                             */
/* ------------------------------------------------------------------ */

export type KpiPeriod = "month" | "quarter";

export interface Bounds {
  /** 'YYYY-MM-DD HH:MM:SS', inclusive, as the stored UTC strings compare. */
  from: string;
  /** Exclusive. */
  to: string;
  /** 'YYYY-MM-DD' of the first and last day, for date-only columns. */
  fromDay: string;
  toDay: string;
  period: KpiPeriod;
  offset: number;
  /** How many months the stretch holds — targets are monthly and scale. */
  months: number;
  /**
   * How much of the stretch has passed, 0..1: 1 for a finished period, the
   * elapsed share for the current one. Targets are pro-rated by it, so on
   * the 3rd of a month nobody is red for not yet having signed the month's
   * two agreements.
   */
  elapsed: number;
}

function stamp(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

/**
 * A calendar month or quarter in the server's local time, `offset` back
 * from the current one. Local for the same reason the weekly report is: the
 * Assembly works UTC+5 and a UTC month would cut the first evening off.
 */
export function kpiBounds(period: KpiPeriod = "month", offset = 0, now = new Date()): Bounds {
  const months = period === "quarter" ? 3 : 1;
  const startMonth =
    period === "quarter"
      ? Math.floor(now.getMonth() / 3) * 3 + offset * 3
      : now.getMonth() + offset;
  const start = new Date(now.getFullYear(), startMonth, 1);
  const end = new Date(start.getFullYear(), start.getMonth() + months, 1);
  const last = new Date(end.getTime() - 86_400_000);
  const elapsed =
    now.getTime() >= end.getTime()
      ? 1
      : Math.max(0, Math.min(1, (now.getTime() - start.getTime()) / (end.getTime() - start.getTime())));
  const day = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return {
    from: stamp(start),
    to: stamp(end),
    fromDay: day(start),
    toDay: day(last),
    period,
    offset,
    months,
    elapsed,
  };
}

/**
 * The targets for a stretch: monthly figures times the months it holds,
 * times the share of it that has passed. Fractional, rounded to a tenth, so
 * "0.9 agreements by the 14th" reads as what it is rather than as a zero.
 */
export function scaleTargets(targets: Targets, months: number, elapsed = 1): Targets {
  const out = { ...targets };
  for (const key of TARGET_KEYS) out[key] = Math.round(targets[key] * months * elapsed * 10) / 10;
  return out;
}
