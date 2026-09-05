import { get } from "./pg";
import { id as parseId, oneOf, str } from "./validate";

/**
 * Shared shaping for the project admin routes. Both create and edit accept the
 * same body, so the coercion lives here rather than being written twice and
 * drifting apart.
 */

/** Short, shouty, URL-safe: the code appears in task references. */
export const PROJECT_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,15}$/;

/**
 * Where a project stands.
 *
 * `FAOL` and `YAKUNLANMOQDA` are the original pair and keep their exact
 * meaning — every row already in the register carries one of them, and
 * renaming either would have rewritten history to make a list look tidier.
 * The other three are what running a project as a workspace turned out to
 * need: work that has not started, work parked on somebody else, and work
 * that is finished rather than finishing.
 *
 * Unknown input falls back to `FAOL` rather than being stored, so a status no
 * screen can label never reaches the database.
 */
export const PROJECT_STATUSES = [
  "REJA",
  "FAOL",
  "PAUZA",
  "YAKUNLANMOQDA",
  "YAKUNLANDI",
] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** A project carries the same four priorities an assignment does. */
export const PROJECT_PRIORITIES = ["PAST", "ORTA", "YUQORI", "KRITIK"] as const;

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
