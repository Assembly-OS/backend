import { all, get } from "./pg";
import { projectScope, type Viewer } from "./project-visibility";
import { doneSql, openSql, overdueSql, silentSql } from "./metrics";
import { stuckCompanies, today, type CompanyRow } from "./crm";
import { missingPassport, type Phase } from "./project-passport";
import { seesEverything } from "./permissions";
import { DEPARTMENTS } from "./types";
import { signalSettings, stageLimits, tierSettings } from "./settings";
import {
  addDaysTo,
  daysBetween,
  isLivePhase,
  konturShares,
  projectRag,
  redShareOk,
  reviewDueOn,
  tierOf,
  type HealthFlags,
  type Rag,
  type SignalSettings,
  type TierSettings,
} from "./signal-rules";

/**
 * The six signals of TZ 7.5 and the chairman's home page of TZ 8.4, read
 * from the records the platform already keeps. No model: these are rules
 * over dates and counts, which is why they work on day one.
 */

/* ------------------------------------------------------------------ */
/* One project's health                                                */
/* ------------------------------------------------------------------ */

export interface ProjectHealth {
  id: number;
  code: string;
  name: string;
  name_ru: string | null;
  name_en: string | null;
  phase: Phase | null;
  tier: string | null;
  klaster_id: number | null;
  klaster_code: string | null;
  owner_id: number | null;
  owner_name: string | null;
  leader_name: string | null;
  deputy_id: number | null;
  deputy_name: string | null;
  next_decision_on: string | null;
  last_reviewed_at: string | null;
  created_at: string;
  /** The newest record about the project: an entry, an event, a meeting, a decision. */
  last_activity: string | null;
  open_tasks: number;
  overdue_tasks: number;
  late_stages: number;
  /** Derived. */
  live: boolean;
  daysQuiet: number;
  reviewDue: string;
  flags: HealthFlags;
  rag: Rag;
}

interface HealthRow extends Omit<ProjectHealth, "live" | "daysQuiet" | "reviewDue" | "flags" | "rag"> {
  description: string | null;
  description_ru: string | null;
  description_en: string | null;
  ppp_state: number | null;
  ppp_public: number | null;
  ppp_private: number | null;
  started_at: string | null;
  deadline: string | null;
  first_result: string | null;
}

const HEALTH_SELECT = `
  SELECT l.id, l.code, l.name, l.name_ru, l.name_en, l.phase, l.tier, l.klaster_id, k.code AS klaster_code,
         l.owner_id, o.full_name AS owner_name, l.leader_name, l.deputy_id, l.deputy_name,
         l.description, l.description_ru, l.description_en,
         l.ppp_state, l.ppp_public, l.ppp_private, l.started_at, l.deadline, l.first_result,
         l.next_decision_on, l.last_reviewed_at, l.created_at,
         GREATEST(
           (SELECT MAX(e.created_at) FROM thread_entries e JOIN project_threads pt ON pt.id = e.thread_id WHERE pt.project_id = l.id),
           (SELECT MAX(t.created_at) FROM tasks t WHERE t.loyiha_id = l.id),
           (SELECT MAX(ev.created_at) FROM task_events ev JOIN tasks t ON t.id = ev.task_id WHERE t.loyiha_id = l.id),
           (SELECT MAX(p.created_at) FROM task_progress p JOIN tasks t ON t.id = p.task_id WHERE t.loyiha_id = l.id),
           (SELECT MAX(COALESCE(m.held_at, m.created_at)) FROM meetings m JOIN meeting_projects mp ON mp.meeting_id = m.id WHERE mp.project_id = l.id),
           (SELECT MAX(d.decided_at) FROM project_decisions d WHERE d.project_id = l.id),
           l.last_reviewed_at
         ) AS last_activity,
         (SELECT COUNT(*) FROM tasks t WHERE t.loyiha_id = l.id AND ${openSql("t")}) AS open_tasks,
         (SELECT COUNT(*) FROM tasks t WHERE t.loyiha_id = l.id AND ${overdueSql("t")}) AS overdue_tasks,
         (SELECT COUNT(*) FROM project_stages s WHERE s.project_id = l.id AND s.fact_end IS NULL AND s.plan_end < ?) AS late_stages
    FROM loyihalar l
    LEFT JOIN klasterlar k ON k.id = l.klaster_id
    LEFT JOIN users o ON o.id = l.owner_id`;

function judge(row: HealthRow, day: string, signal: SignalSettings, tiers: TierSettings): ProjectHealth {
  const live = isLivePhase(row.phase);
  const openTasks = Number(row.open_tasks);
  const overdue = Number(row.overdue_tasks);
  const late = Number(row.late_stages);
  const lastDay = (row.last_activity ?? row.created_at).slice(0, 10);
  const daysQuiet = Math.max(0, daysBetween(lastDay, day));
  const reviewDue = reviewDueOn(row.last_reviewed_at, row.created_at, row.tier, tiers);
  const missing = missingPassport(row);
  const flags: HealthFlags = {
    inactive: live && daysQuiet > signal.inactiveDays[tierOf(row.tier)],
    decisionOverdue: live && Boolean(row.next_decision_on) && row.next_decision_on! < day,
    reviewOverdue: live && reviewDue < day,
    red: live && (late > 0 || (openTasks > 0 && (overdue * 100) / openTasks >= signal.redTaskShare)),
    noOwner: live && !row.owner_id && !row.leader_name?.trim(),
    passportIncomplete:
      live && (missing.includes("leader") || missing.includes("deputy") || missing.includes("ppp")),
  };
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    name_ru: row.name_ru,
    name_en: row.name_en,
    phase: row.phase,
    tier: row.tier,
    klaster_id: row.klaster_id,
    klaster_code: row.klaster_code,
    owner_id: row.owner_id,
    owner_name: row.owner_name,
    leader_name: row.leader_name,
    deputy_id: row.deputy_id,
    deputy_name: row.deputy_name,
    next_decision_on: row.next_decision_on,
    last_reviewed_at: row.last_reviewed_at,
    created_at: row.created_at,
    last_activity: row.last_activity,
    open_tasks: openTasks,
    overdue_tasks: overdue,
    late_stages: late,
    live,
    daysQuiet,
    reviewDue,
    flags,
    rag: live ? projectRag(flags) : "GREEN",
  };
}

/** Every project in the viewer's reach, judged. */
export async function projectHealth(
  viewer: Viewer,
  settings?: { signal: SignalSettings; tiers: TierSettings },
): Promise<ProjectHealth[]> {
  const signal = settings?.signal ?? (await signalSettings());
  const tiers = settings?.tiers ?? (await tierSettings());
  const scope = projectScope(viewer);
  const day = today();
  const rows = await all<HealthRow>(
    `${HEALTH_SELECT} WHERE ${scope.sql} ORDER BY l.code`,
    day,
    day,
    ...scope.params,
  );
  return rows.map((row) => judge(row, day, signal, tiers));
}

export async function projectHealthOf(id: number): Promise<ProjectHealth | undefined> {
  const day = today();
  const row = await get<HealthRow>(`${HEALTH_SELECT} WHERE l.id = ?`, day, day, id);
  return row ? judge(row, day, await signalSettings(), await tierSettings()) : undefined;
}

/* ------------------------------------------------------------------ */
/* The six signals (7.5)                                               */
/* ------------------------------------------------------------------ */

export interface Signals {
  inactive: ProjectHealth[];
  silentTasks: number;
  stuck: (CompanyRow & { days: number })[];
  overloaded: { id: number; full_name: string; projects: { id: number; code: string; name: string }[] }[];
  incompletePassports: ProjectHealth[];
  kontur: { department: string; open: number; share: number; low: boolean }[];
  settings: SignalSettings;
}

const CONTOURS = ["GR", "FR", "BR", "PR"] as const;

export async function signals(viewer: Viewer, health?: ProjectHealth[]): Promise<Signals> {
  const signal = await signalSettings();
  const rows = health ?? (await projectHealth(viewer, { signal, tiers: await tierSettings() }));
  const live = rows.filter((row) => row.live);
  const everything = seesEverything(viewer);
  const scope = projectScope(viewer);
  // Task-based signals: the Assembly's whole work for the chairman's side,
  // the viewer's projects' work for a manager.
  const within = everything ? "" : ` AND tasks.loyiha_id IN (SELECT l.id FROM loyihalar l WHERE ${scope.sql})`;
  const scopeParams = everything ? [] : scope.params;

  const silent = await get<{ n: string }>(`SELECT COUNT(*) AS n FROM tasks WHERE ${silentSql()}${within}`, ...scopeParams);
  const byDepartment = await all<{ department: string | null; n: string }>(
    `SELECT tasks.to_department AS department, COUNT(*) AS n FROM tasks WHERE ${openSql()}${within} GROUP BY tasks.to_department`,
    ...scopeParams,
  );
  const counts: Record<string, number> = {};
  for (const row of byDepartment) if (row.department) counts[row.department] = Number(row.n);

  const leads = new Map<number, { id: number; full_name: string; projects: { id: number; code: string; name: string }[] }>();
  for (const row of live) {
    if (!row.owner_id || (row.tier !== "FLAGSHIP" && row.tier !== "ACTIVE")) continue;
    const entry = leads.get(row.owner_id) ?? { id: row.owner_id, full_name: row.owner_name ?? "", projects: [] };
    entry.projects.push({ id: row.id, code: row.code, name: row.name });
    leads.set(row.owner_id, entry);
  }

  return {
    inactive: live.filter((row) => row.flags.inactive),
    silentTasks: Number(silent?.n ?? 0),
    stuck: await stuckCompanies(await stageLimits()),
    overloaded: [...leads.values()].filter((lead) => lead.projects.length >= signal.overloadProjects),
    incompletePassports: live.filter((row) => row.flags.passportIncomplete),
    kontur: konturShares(counts, DEPARTMENTS, signal.konturMinShare, CONTOURS),
    settings: signal,
  };
}

/* ------------------------------------------------------------------ */
/* The chairman's four blocks (8.4)                                    */
/* ------------------------------------------------------------------ */

/** Block 1: what needs him — red, undecided, quiet or leaderless. */
export function interventions(health: ProjectHealth[]): ProjectHealth[] {
  const order: Record<Rag, number> = { RED: 0, AMBER: 1, GREEN: 2 };
  return health
    .filter((row) => row.live && (row.rag === "RED" || row.flags.inactive))
    .sort((a, b) => order[a.rag] - order[b.rag] || b.daysQuiet - a.daysQuiet);
}

export interface ClusterHealth {
  id: number | null;
  code: string;
  name_uz: string;
  name_uzc: string;
  name_ru: string;
  name_en: string;
  total: number;
  green: number;
  amber: number;
  red: number;
  /** A tier inside the cluster carries more red than its limit allows. */
  alarm: boolean;
}

/** Block 2: the clusters, each with its green, amber and red. */
export async function clusterHealth(health: ProjectHealth[], tiers?: TierSettings): Promise<ClusterHealth[]> {
  const settings = tiers ?? (await tierSettings());
  const clusters = await all<Omit<ClusterHealth, "total" | "green" | "amber" | "red" | "alarm">>(
    "SELECT id, code, name_uz, name_uzc, name_ru, name_en FROM klasterlar ORDER BY position, id",
  );
  const buckets = new Map<number | null, ClusterHealth>();
  for (const cluster of clusters) buckets.set(cluster.id, { ...cluster, total: 0, green: 0, amber: 0, red: 0, alarm: false });
  buckets.set(null, { id: null, code: "NONE", name_uz: "", name_uzc: "", name_ru: "", name_en: "", total: 0, green: 0, amber: 0, red: 0, alarm: false });

  const byTier = new Map<string, { red: number; total: number }>();
  for (const row of health) {
    if (!row.live) continue;
    const bucket = buckets.get(row.klaster_id) ?? buckets.get(null)!;
    bucket.total++;
    if (row.rag === "RED") bucket.red++;
    else if (row.rag === "AMBER") bucket.amber++;
    else bucket.green++;
    const key = `${row.klaster_id ?? "none"}:${tierOf(row.tier)}`;
    const tally = byTier.get(key) ?? { red: 0, total: 0 };
    tally.total++;
    if (row.rag === "RED") tally.red++;
    byTier.set(key, tally);
  }
  for (const [key, tally] of byTier) {
    const [cluster, tier] = key.split(":");
    if (!redShareOk(tally.red, tally.total, tier, settings)) {
      const bucket = buckets.get(cluster === "none" ? null : Number(cluster));
      if (bucket) bucket.alarm = true;
    }
  }
  // The unassigned bucket shows only when something is in it.
  return [...buckets.values()].filter((bucket) => bucket.id !== null || bucket.total > 0);
}

export interface PeriodResults {
  from: string;
  to: string;
  agreements: number;
  amounts: { currency: string; amount: number }[];
  newPartners: number;
  newCompanies: number;
  meetings: number;
  tasksDone: number;
}

/** Block 3: what the period produced — agreements, money, partners. */
export async function periodResults(from: string, to: string): Promise<PeriodResults> {
  const [agreements, amounts, newPartners, newCompanies, meetings, tasksDone] = await Promise.all([
    get<{ n: string }>(
      "SELECT COUNT(*) AS n FROM kelishuvlar WHERE signed_on BETWEEN ? AND ? AND status IN ('OPEN','DONE')",
      from,
      to,
    ),
    all<{ currency: string; amount: string }>(
      `SELECT COALESCE(currency, 'UZS') AS currency, SUM(amount) AS amount FROM kelishuvlar
        WHERE signed_on BETWEEN ? AND ? AND status IN ('OPEN','DONE') AND amount IS NOT NULL
        GROUP BY COALESCE(currency, 'UZS') ORDER BY 2 DESC`,
      from,
      to,
    ),
    get<{ n: string }>(
      "SELECT COUNT(DISTINCT partner_id) AS n FROM partner_stage_history WHERE to_stage = 'ACTIVE' AND changed_at >= ? AND changed_at < ?",
      from,
      addDaysTo(to, 1),
    ),
    get<{ n: string }>("SELECT COUNT(*) AS n FROM partners WHERE created_at >= ? AND created_at < ?", from, addDaysTo(to, 1)),
    get<{ n: string }>("SELECT COUNT(*) AS n FROM meetings WHERE COALESCE(held_at, created_at) >= ? AND COALESCE(held_at, created_at) < ?", from, addDaysTo(to, 1)),
    get<{ n: string }>(`SELECT COUNT(*) AS n FROM tasks WHERE ${doneSql()} AND closed_at >= ? AND closed_at < ?`, from, addDaysTo(to, 1)),
  ]);
  return {
    from,
    to,
    agreements: Number(agreements?.n ?? 0),
    amounts: amounts.map((row) => ({ currency: row.currency, amount: Number(row.amount) })),
    newPartners: Number(newPartners?.n ?? 0),
    newCompanies: Number(newCompanies?.n ?? 0),
    meetings: Number(meetings?.n ?? 0),
    tasksDone: Number(tasksDone?.n ?? 0),
  };
}

export interface UpcomingDecision extends ProjectHealth {
  dueOn: string;
  overdue: boolean;
}

/** Block 4: decisions due within the window, the overdue ones first. */
export function upcomingDecisions(health: ProjectHealth[], days = 14, day = today()): UpcomingDecision[] {
  const limit = addDaysTo(day, days);
  return health
    .filter((row) => row.live)
    .map((row) => {
      const dates = [row.next_decision_on, row.reviewDue].filter((d): d is string => Boolean(d));
      const dueOn = dates.sort()[0];
      return { ...row, dueOn, overdue: dueOn < day };
    })
    .filter((row) => row.dueOn <= limit)
    .sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.code.localeCompare(b.code));
}
