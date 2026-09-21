import { get } from "./pg";
import { id as parseId, oneOf, str } from "./validate";
import { PROJECT_PRIORITIES, PROJECT_STATUSES } from "./project-vocab";
import { PHASES, TIERS, type Phase, type Tier } from "./project-passport";
import type { PassportInput } from "./project-threads";

/**
 * Shared shaping for the project admin routes. Both create and edit accept the
 * same body, so the coercion lives here rather than being written twice and
 * drifting apart.
 */

/** Short, shouty, URL-safe: the code appears in task references. */
export const PROJECT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,15}$/;

/**
 * Re-exported from `project-vocab`, which holds no database import: the
 * "new project" form is a Client Component and needs the status list, and
 * importing it from this module dragged the Postgres driver into the browser
 * bundle. Server code keeps importing from here, as it always did.
 */
export {
  PROJECT_STATUSES,
  PROJECT_PRIORITIES,
  type ProjectStatus,
} from "./project-vocab";

export interface ProjectFields {
  code: string | null;
  name: string | null;
  description: string | null;
  status: (typeof PROJECT_STATUSES)[number];
  progress: number;
  budget: number;
  ownerId: number | null;
  deadline: string | null;
  siteNo: number | null;
}

/** Clamps a number into range, treating anything unparseable as `fallback`. */
function bounded(value: unknown, min: number, max: number, fallback: number) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export async function projectFields(
  body: Record<string, unknown>,
): Promise<ProjectFields> {
  const owner = body.ownerId == null ? null : parseId(body.ownerId);

  return {
    code: str(body.code, 16)?.toUpperCase() ?? null,
    name: str(body.name, 120),
    description: str(body.description, 2000),
    status: oneOf(body.status, PROJECT_STATUSES, "FAOL"),
    progress: Math.round(bounded(body.progress, 0, 100, 0)),
    budget: bounded(body.budget, 0, Number.MAX_SAFE_INTEGER, 0),
    // An owner is only honoured when it names someone who actually exists.
    ownerId:
      owner === null
        ? null
        : ((await get<{ id: number }>(
            "SELECT id FROM users WHERE id = ? AND is_active = 1",
            owner,
          ))?.id ?? null),
    deadline: str(body.deadline, 10),
    siteNo: body.siteNo == null ? null : parseId(body.siteNo),
  };
}

/** True when the code is already taken (comparison is case-insensitive). */
export async function codeTaken(code: string): Promise<boolean> {
  return (
    (await get<{ id: number }>(
      "SELECT id FROM loyihalar WHERE lower(code) = lower(?)",
      code,
    )) !== undefined
  );
}

/* ------------------------------------------------------------------ */
/* The passport                                                        */
/* ------------------------------------------------------------------ */

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
function day(value: unknown): string | null {
  const text = str(value, 10);
  return text && ISO_DAY.test(text) ? text : null;
}

/** A whole percentage, or null when left blank. */
function percent(value: unknown): number | null | "BAD" {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : "BAD";
}

/**
 * Checks a passport the way the TZ asks: only the name is refused when
 * missing, everything else is judged by `missingPassport` and shown.
 *
 * What is refused is what cannot be true — a project that ends before it
 * starts, partnership shares that are not whole percentages or that are all
 * given and do not make a hundred, or a person or cluster that does not exist.
 * Shares left partly blank are not refused: that is an unfinished passport,
 * not a wrong one.
 *
 * A leader or deputy picked from the staff wins over a typed name, so the
 * record never holds both and disagrees with itself.
 */
export async function readPassport(
  body: Record<string, unknown>,
): Promise<{ ok: true; input: PassportInput } | { ok: false; error: string }> {
  const name = str(body.name, 120);
  if (!name) return { ok: false, error: "REQUIRED" };

  const startedAt = day(body.started_at);
  const deadline = day(body.deadline);
  if (startedAt && deadline && deadline < startedAt) return { ok: false, error: "BAD_TERM" };

  const shares = [percent(body.ppp_state), percent(body.ppp_public), percent(body.ppp_private)];
  if (shares.includes("BAD")) return { ok: false, error: "BAD_PPP" };
  const [state, pub, priv] = shares as (number | null)[];
  if (state !== null && pub !== null && priv !== null && state + pub + priv !== 100)
    return { ok: false, error: "BAD_PPP" };

  const person = async (value: unknown) => {
    const id = value == null || value === "" ? null : parseId(value);
    if (id === null) return null;
    return (await get<{ id: number }>("SELECT id FROM users WHERE id = ? AND is_active = 1", id))
      ? id
      : "GONE";
  };
  const ownerId = await person(body.owner_id);
  const deputyId = await person(body.deputy_id);
  if (ownerId === "GONE" || deputyId === "GONE") return { ok: false, error: "GONE" };

  const klaster = body.klaster_id == null || body.klaster_id === "" ? null : parseId(body.klaster_id);
  if (klaster && !(await get("SELECT id FROM klasterlar WHERE id = ?", klaster)))
    return { ok: false, error: "GONE" };

  const budget = Number(body.budget);

  return {
    ok: true,
    input: {
      name,
      name_ru: str(body.name_ru, 120),
      name_en: str(body.name_en, 120),
      description: str(body.description, 2000),
      description_ru: str(body.description_ru, 2000),
      description_en: str(body.description_en, 2000),
      klaster_id: klaster,
      tier: TIERS.includes(body.tier as Tier) ? (body.tier as Tier) : null,
      phase: PHASES.includes(body.phase as Phase) ? (body.phase as Phase) : null,
      stage: str(body.stage, 160),
      priority: oneOf(body.priority, PROJECT_PRIORITIES, "ORTA"),
      owner_id: ownerId,
      leader_name: ownerId ? null : str(body.leader_name, 160),
      deputy_id: deputyId,
      deputy_name: deputyId ? null : str(body.deputy_name, 160),
      ppp_state: state,
      ppp_public: pub,
      ppp_private: priv,
      ppp_state_party: str(body.ppp_state_party, 160),
      ppp_public_party: str(body.ppp_public_party, 160),
      ppp_private_party: str(body.ppp_private_party, 160),
      next_decision_on: day(body.next_decision_on),
      started_at: startedAt,
      deadline,
      // Millions of so'm, as every budget in the platform is stored.
      budget: Number.isFinite(budget) && budget >= 0 ? budget : 0,
      first_result: str(body.first_result, 500),
    },
  };
}
