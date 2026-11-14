import { LEGAL_STATUSES } from "./meeting-fields";
import { REPORTING_STATUSES, silentSql, statusList } from "./metrics";
import { all, type Param } from "./pg";
import { reach } from "./permissions";
import { projectScope } from "./project-visibility";
import { kpiSettings } from "./settings";
import { EXTERNAL_ROLES, isExternal, type Role, type User } from "./types";
import {
  combine,
  fractionPercent,
  meanScore,
  ragOf,
  scaleTargets,
  scoreAction,
  scoreResult,
  TARGET_KEYS,
  type ActionInput,
  type Bounds,
  type GoalProgress,
  type KpiSettings,
  type Rag,
  type ResultActuals,
  type Targets,
} from "./kpi-rules";

/**
 * KPI cards from the records (TZ block 5), for the people a viewer may see
 * (TZ 4.2, "boshqalarning KPI'sini ko'rish"), and their roll-up.
 *
 * Everything is counted in a handful of grouped queries over the whole set
 * of people at once rather than per person: a department head's page would
 * otherwise cost ten queries per employee, and the chairman's a few hundred.
 */

export interface PersonKpi {
  id: number;
  login: string;
  full_name: string;
  role: Role;
  department: string | null;
  manager_id: number | null;
  action: ActionInput;
  actionScore: number | null;
  actuals: ResultActuals;
  /** Capital attracted through agreements the person answered for, by currency. */
  capital: { currency: string; amount: number }[];
  goals: GoalProgress[];
  targets: Targets;
  resultScore: number | null;
  score: number | null;
  rag: Rag | null;
  ratio: KpiSettings["ratios"][Role];
}

/* ------------------------------------------------------------------ */
/* Who may see whom                                                    */
/* ------------------------------------------------------------------ */

/** Ids come from the session or the database; inlining one is safe. */
function int(value: number): number {
  if (!Number.isInteger(value)) throw new Error("not an id");
  return value;
}

/** Staff who are scored at all: on the staff list and taking work. */
const SCORED = `u.is_active = 1 AND u.role NOT IN ('RAIS', ${EXTERNAL_ROLES.map((role) => `'${role}'`).join(",")})`;

/**
 * A WHERE fragment over `u` (a `users` row) for the people whose cards this
 * viewer may open — TZ 4.2's row: the chairman everyone, a department head
 * his department, a cluster head his cluster's project teams, a project lead
 * his team, everyone else himself.
 */
export function kpiScope(user: User): { sql: string; params: Param[] } {
  const self = String(int(user.id));
  switch (reach(user, "viewOthersKpi")) {
    case "yes":
      return { sql: `(${SCORED})`, params: [] };
    case "department":
      return {
        sql: `(${SCORED} AND (u.id = ${self} OR u.manager_id = ${self}${user.department ? " OR u.department = ?" : ""}))`,
        params: user.department ? [user.department] : [],
      };
    case "cluster":
      return {
        sql: `(${SCORED} AND (u.id = ${self} OR u.manager_id = ${self}
                 OR EXISTS (SELECT 1 FROM loyihalar l
                             WHERE l.klaster_id = ?
                               AND (l.owner_id = u.id OR l.deputy_id = u.id
                                    OR EXISTS (SELECT 1 FROM project_members pm
                                                WHERE pm.project_id = l.id AND pm.user_id = u.id)))))`,
        params: [user.klaster_id ?? -1],
      };
    case "team":
      return {
        sql: `(${SCORED} AND (u.id = ${self} OR u.manager_id = ${self}
                 OR EXISTS (SELECT 1 FROM loyihalar l
                             WHERE (l.owner_id = ${self} OR l.deputy_id = ${self}
                                    OR EXISTS (SELECT 1 FROM project_members me
                                                WHERE me.project_id = l.id AND me.user_id = ${self}))
                               AND (l.owner_id = u.id OR l.deputy_id = u.id
                                    OR EXISTS (SELECT 1 FROM project_members pm
                                                WHERE pm.project_id = l.id AND pm.user_id = u.id)))))`,
        params: [],
      };
    default:
      return { sql: `(u.id = ${self} AND u.is_active = 1)`, params: [] };
  }
}

/** Whether the viewer may open this person's card. */
export async function canSeeKpi(viewer: User, userId: number): Promise<boolean> {
  const scope = kpiScope(viewer);
  const rows = await all<{ id: number }>(
    `SELECT u.id FROM users u WHERE u.id = ? AND ${scope.sql}`,
    userId,
    ...scope.params,
  );
  return rows.length > 0;
}

/* ------------------------------------------------------------------ */
/* Counting                                                            */
/* ------------------------------------------------------------------ */

interface Row {
  id: number;
  login: string;
  full_name: string;
  role: Role;
  department: string | null;
  manager_id: number | null;
  ontime_good: number;
  ontime_total: number;
  reporting_total: number;
  reporting_silent: number;
  approved: number;
  returned: number;
  meetings_total: number;
  meetings_complete: number;
  agreements: number;
  contracts: number;
  obligations: number;
  partners: number;
  phases: number;
}

/** SQL: a meeting row `m` carries every field TZ 1.1 requires. */
const MEETING_COMPLETE = `
  (m.held_at IS NOT NULL AND m.held_at <> '' AND m.company_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM meeting_projects mp WHERE mp.meeting_id = m.id)
   AND COALESCE(m.participants, '') <> ''
   AND EXISTS (SELECT 1 FROM meeting_staff ms2 WHERE ms2.meeting_id = m.id)
   AND COALESCE(m.description, '') <> '' AND COALESCE(m.agreed, '') <> ''
   AND COALESCE(m.next_steps, '') <> '' AND m.responsible_id IS NOT NULL
   AND m.legal_status IN (${LEGAL_STATUSES.map((status) => `'${status}'`).join(",")}))`;

/**
 * Every figure for every person in `scope`, in one statement. Each metric
 * is a correlated subquery with its own predicate, as the weekly report
 * does it — a join fan-out would multiply the counts.
 *
 * Placeholders, in order: the scope's own, then the period bounds as the
 * subqueries need them. `today` is the cut for "on time": deadline work due
 * after today is not yet decidable and is left out of the fraction.
 */
async function countAll(
  scope: { sql: string; params: Param[] },
  bounds: Bounds,
  today: string,
): Promise<Row[]> {
  const { from, to, fromDay, toDay } = bounds;
  const due = toDay < today ? toDay : today;
  return await all<Row>(
    `SELECT u.id, u.login, u.full_name, u.role, u.department, u.manager_id,
       -- Deadline work due in the period, up to today: finished by its deadline…
       (SELECT COUNT(*) FROM task_stages s JOIN tasks t ON t.id = s.task_id
         WHERE s.to_user_id = u.id AND t.kind = 'MUDDATLI' AND t.deadline IS NOT NULL
           AND t.deadline >= ? AND t.deadline <= ?
           AND s.status = 'BAJARILDI' AND s.closed_at IS NOT NULL
           AND substr(s.closed_at, 1, 10) <= t.deadline) AS ontime_good,
       -- …out of all of it that was due (still open past its date counts as late).
       (SELECT COUNT(*) FROM task_stages s JOIN tasks t ON t.id = s.task_id
         WHERE s.to_user_id = u.id AND t.kind = 'MUDDATLI' AND t.deadline IS NOT NULL
           AND t.deadline >= ? AND t.deadline <= ?
           AND s.status NOT IN ('KUTMOQDA', 'RAD_ETILDI')) AS ontime_total,
       -- Open-ended work in hand: reporting on rhythm, or silent.
       (SELECT COUNT(*) FROM tasks t WHERE t.to_user_id = u.id AND t.kind = 'MUDDATSIZ'
           AND t.status IN (${statusList(REPORTING_STATUSES)})) AS reporting_total,
       (SELECT COUNT(*) FROM tasks t WHERE t.to_user_id = u.id AND ${silentSql("t")}) AS reporting_silent,
       -- Hand-ins approved vs sent back, credited to the stage's holder.
       (SELECT COUNT(*) FROM task_events e JOIN tasks t ON t.id = e.task_id
          LEFT JOIN task_stages s ON s.task_id = t.id AND s.position = e.stage_position
         WHERE COALESCE(s.to_user_id, t.to_user_id) = u.id
           AND e.action IN ('TASDIQLANDI','BOSQICH_TASDIQLANDI')
           AND e.created_at >= ? AND e.created_at < ?) AS approved,
       (SELECT COUNT(*) FROM task_events e JOIN tasks t ON t.id = e.task_id
          LEFT JOIN task_stages s ON s.task_id = t.id AND s.position = e.stage_position
         WHERE COALESCE(s.to_user_id, t.to_user_id) = u.id
           AND e.action = 'QAYTARILDI'
           AND e.created_at >= ? AND e.created_at < ?) AS returned,
       -- Meetings sat in or filed during the period, and how many are written up.
       (SELECT COUNT(*) FROM meetings m
         WHERE (m.owner_id = u.id OR EXISTS (SELECT 1 FROM meeting_staff ms WHERE ms.meeting_id = m.id AND ms.user_id = u.id))
           AND COALESCE(m.held_at, substr(m.created_at, 1, 10)) >= ?
           AND COALESCE(m.held_at, substr(m.created_at, 1, 10)) <= ?) AS meetings_total,
       (SELECT COUNT(*) FROM meetings m
         WHERE (m.owner_id = u.id OR EXISTS (SELECT 1 FROM meeting_staff ms WHERE ms.meeting_id = m.id AND ms.user_id = u.id))
           AND COALESCE(m.held_at, substr(m.created_at, 1, 10)) >= ?
           AND COALESCE(m.held_at, substr(m.created_at, 1, 10)) <= ?
           AND ${MEETING_COMPLETE}) AS meetings_complete,
       -- Results. Agreements signed as responsible, in the period.
       (SELECT COUNT(*) FROM kelishuvlar k
         WHERE k.responsible_id = u.id AND k.status IN ('OPEN','DONE')
           AND k.signed_on IS NOT NULL AND k.signed_on >= ? AND k.signed_on <= ?) AS agreements,
       (SELECT COUNT(*) FROM kelishuvlar k
         WHERE k.responsible_id = u.id AND k.status IN ('OPEN','DONE') AND k.kind = 'CONTRACT'
           AND k.signed_on IS NOT NULL AND k.signed_on >= ? AND k.signed_on <= ?) AS contracts,
       -- Commitments to partners closed as done, as owner.
       (SELECT COUNT(*) FROM agreements a
         WHERE a.owner_user_id = u.id AND a.status = 'DONE'
           AND a.done_at IS NOT NULL AND a.done_at >= ? AND a.done_at < ?) AS obligations,
       -- Companies brought into the CRM, as owner.
       (SELECT COUNT(*) FROM partners p
         WHERE p.owner_user_id = u.id
           AND COALESCE(p.created_at, p.first_seen) >= ? AND COALESCE(p.created_at, p.first_seen) < ?) AS partners,
       -- Projects led that moved to a later phase: the audit journal records
       -- every passport change, so a phase move is a row with a 'phase' key.
       (SELECT COUNT(*) FROM audit_log al JOIN loyihalar l ON l.id = al.entity_id::integer
         -- jsonb_exists, not the question-mark operator: lib/pg rewrites every
         -- question mark into a numbered placeholder, the operator included.
         WHERE al.entity = 'loyihalar' AND al.action = 'UPDATE' AND jsonb_exists(al.detail, 'phase')
           AND (l.owner_id = u.id OR l.deputy_id = u.id)
           AND al.at >= ? AND al.at < ?) AS phases
     FROM users u
     WHERE ${scope.sql}
     ORDER BY u.full_name`,
    fromDay, due, fromDay, due,
    from, to, from, to,
    fromDay, toDay, fromDay, toDay,
    fromDay, toDay, fromDay, toDay,
    from, to, from, to, from, to,
    ...scope.params,
  );
}

interface CapitalRow {
  responsible_id: number;
  currency: string;
  amount: number;
}

interface GoalRow extends GoalProgress {
  to_user_id: number;
}

/* ------------------------------------------------------------------ */
/* Cards                                                               */
/* ------------------------------------------------------------------ */

/** The cards of everyone in the viewer's reach, for one period. */
export async function kpiBoard(
  viewer: User,
  bounds: Bounds,
  settings?: KpiSettings,
): Promise<PersonKpi[]> {
  const config = settings ?? (await kpiSettings());
  const scope = kpiScope(viewer);
  const today = new Date().toISOString().slice(0, 10);
  const rows = await countAll(scope, bounds, today);
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const marks = ids.map(() => "?").join(",");

  const [capital, goals] = await Promise.all([
    all<CapitalRow>(
      `SELECT k.responsible_id, COALESCE(k.currency, 'UZS') AS currency, SUM(k.amount) AS amount
         FROM kelishuvlar k
        WHERE k.responsible_id IN (${marks}) AND k.status IN ('OPEN','DONE') AND k.amount IS NOT NULL
          AND k.signed_on IS NOT NULL AND k.signed_on >= ? AND k.signed_on <= ?
        GROUP BY k.responsible_id, COALESCE(k.currency, 'UZS')`,
      ...ids,
      bounds.fromDay,
      bounds.toDay,
    ),
    all<GoalRow>(
      `SELECT t.to_user_id, t.id AS "taskId", t.code, t.title, t.target_value AS target, t.target_unit AS unit,
              (SELECT p.metric FROM task_progress p WHERE p.task_id = t.id AND p.metric IS NOT NULL
                ORDER BY p.id DESC LIMIT 1) AS latest
         FROM tasks t
        WHERE t.to_user_id IN (${marks}) AND t.kind = 'MUDDATSIZ' AND t.target_value IS NOT NULL
          AND t.target_value > 0 AND t.status IN (${statusList(REPORTING_STATUSES)})`,
      ...ids,
    ),
  ]);

  return rows.map((row) => {
    const action: ActionInput = {
      onTime: { good: Number(row.ontime_good), total: Number(row.ontime_total) },
      reporting: {
        good: Number(row.reporting_total) - Number(row.reporting_silent),
        total: Number(row.reporting_total),
      },
      rework: { good: Number(row.approved), total: Number(row.approved) + Number(row.returned) },
      meetings: { good: Number(row.meetings_complete), total: Number(row.meetings_total) },
    };
    const actuals: ResultActuals = {
      agreements: Number(row.agreements),
      obligations: Number(row.obligations),
      partners: Number(row.partners),
      phases: Number(row.phases),
      contracts: Number(row.contracts),
    };
    const own = goals
      .filter((goal) => goal.to_user_id === row.id)
      .map(({ to_user_id: _owner, ...goal }) => {
        void _owner;
        return { ...goal, target: Number(goal.target), latest: goal.latest === null ? null : Number(goal.latest) };
      });
    const targets = scaleTargets(config.targets[row.role] ?? config.targets.ISHCHI, bounds.months, bounds.elapsed);
    const ratio = config.ratios[row.role] ?? config.ratios.ISHCHI;
    const actionScore = scoreAction(action);
    const resultScore = scoreResult(actuals, targets, own);
    const score = combine(actionScore, resultScore, ratio);
    return {
      id: row.id,
      login: row.login,
      full_name: row.full_name,
      role: row.role,
      department: row.department,
      manager_id: row.manager_id,
      action,
      actionScore,
      actuals,
      capital: capital
        .filter((item) => item.responsible_id === row.id)
        .map((item) => ({ currency: item.currency, amount: Number(item.amount) })),
      goals: own,
      targets,
      resultScore,
      score,
      rag: ragOf(score, config.rag),
      ratio,
    };
  });
}

/** One person's card, if the viewer may see it. */
export async function personKpi(
  viewer: User,
  userId: number,
  bounds: Bounds,
): Promise<PersonKpi | null> {
  if (!(await canSeeKpi(viewer, userId))) return null;
  const board = await kpiBoard(viewer, bounds);
  return board.find((card) => card.id === userId) ?? null;
}

/* ------------------------------------------------------------------ */
/* Roll-up (TZ 5.4)                                                     */
/* ------------------------------------------------------------------ */

export interface GroupKpi {
  key: string;
  label: string;
  /** People scored in this group. */
  people: number;
  score: number | null;
  rag: Rag | null;
  green: number;
  amber: number;
  red: number;
  /** Share of deadline work that was late, in percent, against the limit. */
  lateShare: number | null;
  /** Share of open-ended work that is silent, in percent, against the limit. */
  silentShare: number | null;
}

export interface KpiRollup {
  departments: GroupKpi[];
  projects: GroupKpi[];
  clusters: GroupKpi[];
  ecosystem: GroupKpi;
}

function group(key: string, label: string, cards: PersonKpi[], settings: KpiSettings): GroupKpi {
  const score = meanScore(cards.map((card) => card.score));
  const late = cards.reduce((sum, card) => sum + card.action.onTime.total - card.action.onTime.good, 0);
  const due = cards.reduce((sum, card) => sum + card.action.onTime.total, 0);
  const silent = cards.reduce((sum, card) => sum + card.action.reporting.total - card.action.reporting.good, 0);
  const reporting = cards.reduce((sum, card) => sum + card.action.reporting.total, 0);
  return {
    key,
    label,
    people: cards.length,
    score,
    rag: ragOf(score, settings.rag),
    green: cards.filter((card) => card.rag === "GREEN").length,
    amber: cards.filter((card) => card.rag === "AMBER").length,
    red: cards.filter((card) => card.rag === "RED").length,
    lateShare: due > 0 ? Math.round((100 * late) / due) : null,
    silentShare: reporting > 0 ? Math.round((100 * silent) / reporting) : null,
  };
}

/**
 * Person → department or project → cluster → ecosystem. A department is the
 * mean of its people; a project the mean of the people attached to it; a
 * cluster the mean of its projects; the ecosystem the mean of everyone.
 * Projects and clusters are limited to what the viewer may see.
 */
export async function kpiRollup(
  viewer: User,
  cards: PersonKpi[],
  settings: KpiSettings,
): Promise<KpiRollup> {
  const byId = new Map(cards.map((card) => [card.id, card]));

  const departments = ["GR", "FR", "BR", "PR", "AI_LAB"]
    .map((department) =>
      group(
        department,
        department,
        cards.filter((card) => card.department === department),
        settings,
      ),
    )
    .filter((item) => item.people > 0);

  const scope = projectScope(viewer, "l");
  const memberships = await all<{ project_id: number; code: string; name: string; klaster_id: number | null; user_id: number }>(
    `SELECT l.id AS project_id, l.code, l.name, l.klaster_id, p.user_id
       FROM loyihalar l
       JOIN LATERAL (
         SELECT l.owner_id AS user_id WHERE l.owner_id IS NOT NULL
         UNION SELECT l.deputy_id WHERE l.deputy_id IS NOT NULL
         UNION SELECT pm.user_id FROM project_members pm WHERE pm.project_id = l.id
       ) p ON TRUE
      WHERE ${scope.sql}
      ORDER BY l.code`,
    ...scope.params,
  );
  const projectCards = new Map<number, { code: string; name: string; klaster_id: number | null; cards: PersonKpi[] }>();
  for (const row of memberships) {
    const card = byId.get(row.user_id);
    if (!card) continue;
    const entry = projectCards.get(row.project_id) ?? { code: row.code, name: row.name, klaster_id: row.klaster_id, cards: [] };
    entry.cards.push(card);
    projectCards.set(row.project_id, entry);
  }
  const projects = [...projectCards.entries()].map(([id, entry]) =>
    group(String(id), `${entry.code} · ${entry.name}`, entry.cards, settings),
  );

  const clusterRows = await all<{ id: number; code: string }>("SELECT id, code FROM klasterlar ORDER BY position");
  const clusters = clusterRows
    .map((cluster) => {
      const members = [...projectCards.values()].filter((entry) => entry.klaster_id === cluster.id);
      const scores = members.map((entry) => meanScore(entry.cards.map((card) => card.score)));
      const people = new Set(members.flatMap((entry) => entry.cards.map((card) => card.id)));
      const score = meanScore(scores);
      const rolled = group(String(cluster.id), cluster.code, [...people].map((id) => byId.get(id)!), settings);
      return { ...rolled, score, rag: ragOf(score, settings.rag) };
    })
    .filter((item) => item.people > 0);

  return {
    departments,
    projects,
    clusters,
    ecosystem: group("all", "all", cards, settings),
  };
}

/** Whether this viewer sees roll-ups at all — department reach or wider. */
export function seesRollup(user: User): boolean {
  const scope = reach(user, "viewOthersKpi");
  return !isExternal(user.role) && (scope === "yes" || scope === "department" || scope === "cluster" || scope === "team");
}

export { fractionPercent, TARGET_KEYS };
