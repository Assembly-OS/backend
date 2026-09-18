import type { ProjectStatus } from "./project-vocab";

/**
 * What a project passport must hold, block 1.3 of the rebuild TZ, with nothing
 * that touches the database — the passport form is a client component and the
 * tests import it directly.
 */

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

/**
 * The life cycle, in order. FEASIBILITY is the TZ's "TIA" — the techno-
 * economic feasibility study. CLOSED and FROZEN are where a project ends up,
 * not steps it passes through.
 */
export const PHASES = [
  "CONCEPT",
  "FEASIBILITY",
  "PREPARATION",
  "EXECUTION",
  "MONITORING",
  "CLOSED",
  "FROZEN",
] as const;
export type Phase = (typeof PHASES)[number];

/**
 * How closely a project is watched. The TZ sizes them at about ten flagships
 * reviewed weekly, thirty active ones monthly and sixty in the pipeline
 * quarterly — one level of scrutiny for a hundred projects would drown the
 * small ones in paperwork.
 */
export const TIERS = ["FLAGSHIP", "ACTIVE", "PIPELINE"] as const;
export type Tier = (typeof TIERS)[number];

/**
 * The older `status` a phase implies, written alongside it on every save.
 *
 * `status` predates the passport and other code still reads it; keeping it a
 * function of the phase means it can never disagree with it. Every phase maps
 * to exactly one status, so the mapping cannot be ambiguous.
 */
export const PHASE_STATUS: Record<Phase, ProjectStatus> = {
  CONCEPT: "REJA",
  FEASIBILITY: "FAOL",
  PREPARATION: "FAOL",
  EXECUTION: "FAOL",
  MONITORING: "YAKUNLANMOQDA",
  CLOSED: "YAKUNLANDI",
  FROZEN: "PAUZA",
};

/* ------------------------------------------------------------------ */
/* Partnership shares                                                  */
/* ------------------------------------------------------------------ */

export interface PppShares {
  state: number | null;
  public: number | null;
  private: number | null;
}

/**
 * Whether the three shares describe a whole project.
 *
 * All three are given — a zero is an answer, a blank is not — and they total a
 * hundred. A split that adds to ninety is a typo, and one that adds to a
 * hundred and ten is two people's numbers merged; either way it is not the
 * project's structure, and the passport says so rather than rounding it off.
 */
export function pppComplete(shares: PppShares): boolean {
  const values = [shares.state, shares.public, shares.private];
  if (values.some((value) => value === null || !Number.isInteger(value))) return false;
  if (values.some((value) => (value as number) < 0 || (value as number) > 100)) return false;
  return (values as number[]).reduce((sum, value) => sum + value, 0) === 100;
}

/* ------------------------------------------------------------------ */
/* Completeness                                                        */
/* ------------------------------------------------------------------ */

/**
 * The fields the TZ marks required, in the order a reader checks them.
 *
 * Judged, never refused, like a meeting and an agreement — a project whose
 * deputy is still being chosen is a project. The TZ's own rule is that an
 * incomplete passport is kept as a draft, not turned away.
 *
 * Names and descriptions count as filled only in all three languages the TZ
 * asks for; the leader and the deputy by a staff member or a name.
 */
export const PASSPORT_REQUIRED = [
  "names",
  "descriptions",
  "cluster",
  "tier",
  "leader",
  "deputy",
  "ppp",
  "phase",
  "next_decision",
  "dates",
  "first_result",
] as const;
export type PassportField = (typeof PASSPORT_REQUIRED)[number];

export interface PassportShape {
  name: string | null;
  name_ru: string | null;
  name_en: string | null;
  description: string | null;
  description_ru: string | null;
  description_en: string | null;
  klaster_id: number | null;
  tier: string | null;
  owner_id: number | null;
  leader_name: string | null;
  deputy_id: number | null;
  deputy_name: string | null;
  ppp_state: number | null;
  ppp_public: number | null;
  ppp_private: number | null;
  phase: string | null;
  next_decision_on: string | null;
  started_at: string | null;
  deadline: string | null;
  first_result: string | null;
}

const filled = (value: string | null | undefined) => Boolean(value?.trim());

/** The required fields this passport still lacks. Empty means complete. */
export function missingPassport(p: PassportShape): PassportField[] {
  const has: Record<PassportField, boolean> = {
    names: filled(p.name) && filled(p.name_ru) && filled(p.name_en),
    descriptions:
      filled(p.description) && filled(p.description_ru) && filled(p.description_en),
    cluster: p.klaster_id != null,
    tier: TIERS.includes(p.tier as Tier),
    leader: p.owner_id != null || filled(p.leader_name),
    deputy: p.deputy_id != null || filled(p.deputy_name),
    ppp: pppComplete({ state: p.ppp_state, public: p.ppp_public, private: p.ppp_private }),
    phase: PHASES.includes(p.phase as Phase),
    next_decision: filled(p.next_decision_on),
    dates: filled(p.started_at) && filled(p.deadline),
    first_result: filled(p.first_result),
  };
  return PASSPORT_REQUIRED.filter((field) => !has[field]);
}

/**
 * The TZ's entry condition: a project joins the register only with a leader,
 * a deputy, its partnership shares, a cluster, a tier and a first result.
 * Short of those it is a draft — shown, but marked as not yet admitted.
 */
const ENTRY: PassportField[] = ["leader", "deputy", "ppp", "cluster", "tier", "first_result"];

export function isDraft(p: PassportShape): boolean {
  const missing = missingPassport(p);
  return ENTRY.some((field) => missing.includes(field));
}

/* ------------------------------------------------------------------ */
/* Reading in the reader's language                                    */
/* ------------------------------------------------------------------ */

/**
 * The Uzbek text, or its Russian or English version for a reader in that
 * language when one has been written. Cyrillic Uzbek reads the Uzbek — the
 * same language, and the TZ asks for three, not four.
 */
export function inLocale(
  locale: string,
  uz: string | null,
  ru: string | null,
  en: string | null,
): string | null {
  if (locale === "ru" && ru?.trim()) return ru;
  if (locale === "en" && en?.trim()) return en;
  return uz;
}

/** A cluster's name in the reader's language; clusters carry all four. */
export function clusterName(
  locale: string,
  names: { uz: string | null; uzc: string | null; ru: string | null; en: string | null },
): string | null {
  const byLocale: Record<string, string | null> = {
    uz: names.uz,
    uzc: names.uzc,
    ru: names.ru,
    en: names.en,
  };
  return byLocale[locale] ?? names.uz;
}
