import { get, insert, now, run } from "./pg";
import { hashPassword } from "./auth";
import { publish } from "./events";
import { activeRaisCount, loginTaken, LOGIN_PATTERN, MIN_PASSWORD } from "./admin";
import { id as parseId, oneOf, str } from "./validate";
import {
  DEPARTMENTS,
  ROLES,
  isAssociationRole,
  isExternal,
  receivesTasks,
  type Department,
  type Role,
} from "./types";
import { attach } from "./project-visibility";
import { grantsGlobalAi } from "./permissions";
import { LOCALES } from "./i18n/config";

/**
 * Creating, editing and removing staff accounts, with the rules in one place.
 *
 * Two doors open onto this: the standalone `/admin` panel, and the staff
 * section on the profile page that the chairman and his assistant see. They
 * differ only in who is allowed through — what may be written, and what would
 * leave the Assembly without a chairman, is the same question either way, and
 * it was not going to stay the same answer in two copies.
 *
 * Each function returns the HTTP status and the body the route should send, so
 * the routes stay what they should be: a check on the caller and nothing else.
 */

export interface StaffWrite {
  status: number;
  body: Record<string, unknown>;
}

const OK: StaffWrite = { status: 200, body: { ok: true } };

function fail(status: number, error: string): StaffWrite {
  return { status, body: { error } };
}

/**
 * The department a staff member belongs to — required, and that is new.
 *
 * It used to fall back to NULL whenever the field was missing or misspelt,
 * and the cost of that silence compounds. A task takes its department from
 * whoever it is assigned to, so a person with no department mints assignments
 * that belong to no department, and those never reach the chart on the
 * statistics page: the audit found 26 of 67 assignments (39%) invisible that
 * way, growing daily. The chairman was reading 61% of the work as if it were
 * all of it.
 *
 * The exception is the chairman, and the test says why rather than naming him:
 * the department is required of exactly the people who can receive an
 * assignment, because they are exactly the people who can mint one that
 * belongs nowhere. The chairman only hands work out and accepts results, so
 * the field has nothing to do for him — the departments are operating arms and
 * he heads the Assembly rather than one of them. Forcing a choice there would
 * teach whoever fills the form that the field is arbitrary, which is how it
 * ends up wrong everywhere else.
 *
 * Project leads do receive work, so they are not exceptions. People outside
 * the Assembly (TZ 4.1 — an outside project lead, the association roles)
 * receive none and belong to no department, so for them the field is cleared.
 */
/**
 * Whether this account may be saved without a manager.
 *
 * The same shape of rule as the department, and the same reason. The team page
 * builds "my team" from `manager_id` and the assignment form now groups by it
 * too, so a person with no manager belongs to nobody's team on either screen —
 * they are assignable and invisible at once. The audit found the team page
 * empty for exactly this reason.
 *
 * The chairman reports to no one, so he is the exception, as he is for the
 * department.
 */
function managerRequired(role: Role): boolean {
  return role !== "RAIS";
}

function readDepartment(
  value: unknown,
  role: Role,
): { ok: true; department: Department | null } | { ok: false } {
  // Someone outside the Assembly belongs to none of its departments; a value
  // left in the form from an earlier role is dropped, not stored.
  if (isExternal(role)) return { ok: true, department: null };
  if (DEPARTMENTS.includes(value as Department))
    return { ok: true, department: value as Department };
  if (!receivesTasks(role)) return { ok: true, department: null };
  return { ok: false };
}

/**
 * What a role is scoped by (TZ 4.1), checked against rows that exist: a
 * cluster head's cluster, an association role's association, an outside
 * project lead's project. Each is required of its role and cleared for every
 * other, so a person who changes role does not keep the old one's reach.
 */
async function readScope(
  body: Record<string, unknown>,
  role: Role,
): Promise<
  | { ok: true; klasterId: number | null; uyushmaId: number | null; projectId: number | null }
  | { ok: false; error: string }
> {
  const pick = async (value: unknown, table: string): Promise<number | null> => {
    const wanted = value == null || value === "" ? null : parseId(value);
    if (wanted === null) return null;
    return (
      (await get<{ id: number }>(`SELECT id FROM ${table} WHERE id = ?`, wanted))?.id ?? null
    );
  };
  const klasterId =
    role === "KLASTER_RAHBARI" ? await pick(body.klasterId, "klasterlar") : null;
  if (role === "KLASTER_RAHBARI" && klasterId === null)
    return { ok: false, error: "KLASTER_REQUIRED" };
  const uyushmaId = isAssociationRole(role)
    ? await pick(body.uyushmaId, "uyushmalar")
    : null;
  if (isAssociationRole(role) && uyushmaId === null)
    return { ok: false, error: "UYUSHMA_REQUIRED" };
  const projectId =
    role === "TASHQI_LOYIHA_RAHBARI" ? await pick(body.projectId, "loyihalar") : null;
  return { ok: true, klasterId, uyushmaId, projectId };
}

/** Creates a staff account and returns its id and login. */
export async function createStaffAccount(
  body: Record<string, unknown>,
): Promise<StaffWrite> {
  const fullName = str(body.fullName, 120);
  const login = str(body.login, 32)?.toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";

  if (!fullName || !login) return fail(400, "REQUIRED");
  if (!LOGIN_PATTERN.test(login)) return fail(400, "BAD_LOGIN");
  if (password.length < MIN_PASSWORD) return fail(400, "WEAK_PASSWORD");
  if (await loginTaken(login)) return fail(409, "LOGIN_TAKEN");

  const role = oneOf(body.role, ROLES, "ISHCHI");
  const picked = readDepartment(body.department, role);
  if (!picked.ok) return fail(400, "DEPARTMENT_REQUIRED");
  const department = picked.department;
  const scope = await readScope(body, role);
  if (!scope.ok) return fail(400, scope.error);
  // An outside lead without a project would sign in to an empty screen.
  if (role === "TASHQI_LOYIHA_RAHBARI" && scope.projectId === null)
    return fail(400, "PROJECT_REQUIRED");
  const position = str(body.position, 160);
  const phone = str(body.phone, 40);
  const email = str(body.email, 120);
  const lang = oneOf(body.lang, LOCALES, "uz");

  // A manager id is only honoured when it names someone who actually exists.
  const managerId = body.managerId == null ? null : parseId(body.managerId);
  const manager =
    managerId === null
      ? null
      : ((
          await get<{ id: number }>(
            "SELECT id FROM users WHERE id = ? AND is_active = 1",
            managerId,
          )
        )?.id ?? null);

  if (manager === null && managerRequired(role))
    return fail(400, "MANAGER_REQUIRED");

  // RETURNING rather than a follow-up SELECT: the id comes back with the write,
  // and one round trip fewer counts now that the database is over a socket.
  const created = await insert(
    `INSERT INTO users (login, password_hash, full_name, role, department, position,
                        manager_id, klaster_id, uyushma_id, phone, email, lang,
                        is_active, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
    login,
    hashPassword(password),
    fullName,
    role,
    department,
    position,
    manager,
    scope.klasterId,
    scope.uyushmaId,
    phone,
    email,
    lang,
    now(),
  );
  if (scope.projectId !== null) await attach(scope.projectId, created, manager);

  // The new colleague shows up in everyone's staff directory right away.
  publish(created);

  return { status: 200, body: { ok: true, id: created, login } };
}

interface Target {
  id: number;
  role: Role;
  is_active: number;
}

/**
 * Edits one staff account: profile fields, a new password, or the active flag.
 * Deactivating blocks the login and hides the person from every picker, which
 * is what "remove" means in an org chart for anyone who has worked here.
 *
 * `actorId` is the signed-in member of staff doing the editing, or null when
 * the request came from the `/admin` panel, which is not a person in the org
 * chart and therefore has no account to lock itself out of.
 */
export async function updateStaffAccount(
  targetId: number,
  body: Record<string, unknown>,
  actorId: number | null,
): Promise<StaffWrite> {
  const target = await get<Target>(
    "SELECT id, role, is_active FROM users WHERE id = ?",
    targetId,
  );
  if (!target) return fail(404, "NOT_FOUND");

  const action = str(body.action, 20);

  if (action === "toggle") {
    const activate = target.is_active === 0;
    // Turning off your own account signs you out of the screen you are
    // standing on, and nothing in the platform would let you back in.
    if (!activate && actorId !== null && actorId === targetId)
      return fail(400, "SELF");
    // The Assembly needs a chairman: the last active one stays active.
    if (!activate && target.role === "RAIS" && (await activeRaisCount()) <= 1)
      return fail(400, "LAST_RAIS");

    await run(
      "UPDATE users SET is_active = ? WHERE id = ?",
      activate ? 1 : 0,
      targetId,
    );
    publish(targetId);
    return { status: 200, body: { ok: true, is_active: activate ? 1 : 0 } };
  }

  if (action === "globalAi") {
    // TZ 4.2: the global AI view is a grant the chairman's side gives a
    // particular department head, or takes back, without touching his role.
    if (!grantsGlobalAi(target.role)) return fail(400, "NOT_GRANTABLE");
    const on = body.on === true;
    await run("UPDATE users SET global_ai = ? WHERE id = ?", on ? 1 : 0, targetId);
    publish(targetId);
    return { status: 200, body: { ok: true, global_ai: on ? 1 : 0 } };
  }

  if (action === "password") {
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < MIN_PASSWORD) return fail(400, "WEAK_PASSWORD");

    await run(
      "UPDATE users SET password_hash = ? WHERE id = ?",
      hashPassword(password),
      targetId,
    );
    return OK;
  }

  if (action === "update") {
    const fullName = str(body.fullName, 120);
    if (!fullName) return fail(400, "REQUIRED");

    const role = oneOf(body.role, ROLES, target.role);
    // Same reasoning as above, from the other direction: do not demote the only
    // chairman into a role that cannot hand out work.
    if (target.role === "RAIS" && role !== "RAIS" && (await activeRaisCount()) <= 1)
      return fail(400, "LAST_RAIS");

    const picked = readDepartment(body.department, role);
    if (!picked.ok) return fail(400, "DEPARTMENT_REQUIRED");
    const department = picked.department;
    const scope = await readScope(body, role);
    if (!scope.ok) return fail(400, scope.error);
    const managerId = body.managerId == null ? null : parseId(body.managerId);
    // Nobody reports to themselves, and a manager must exist.
    const manager =
      managerId === null || managerId === targetId
        ? null
        : ((
            await get<{ id: number }>(
              "SELECT id FROM users WHERE id = ? AND is_active = 1",
              managerId,
            )
          )?.id ?? null);

    if (manager === null && managerRequired(role))
      return fail(400, "MANAGER_REQUIRED");

    await run(
      `UPDATE users SET full_name = ?, role = ?, department = ?, position = ?,
                        manager_id = ?, klaster_id = ?, uyushma_id = ?,
                        phone = ?, email = ?,
                        -- A grant does not outlive the role that could hold it.
                        global_ai = CASE WHEN ? = 1 THEN global_ai ELSE 0 END
        WHERE id = ?`,
      fullName,
      role,
      department,
      str(body.position, 160),
      manager,
      scope.klasterId,
      scope.uyushmaId,
      str(body.phone, 40),
      str(body.email, 120),
      grantsGlobalAi(role) ? 1 : 0,
      targetId,
    );
    // Adds the project named in the form; projects attached from the
    // project's own page stay attached.
    if (scope.projectId !== null) await attach(scope.projectId, targetId, actorId);
    publish(targetId);
    return OK;
  }

  return fail(400, "BAD_ACTION");
}

/**
 * Removes a staff account outright.
 *
 * Deactivating is still the right answer for someone who has worked here:
 * assignments, chat messages and meeting records name them, and the schema
 * enforces that with foreign keys. This exists for the other case — an account
 * created by mistake, or a duplicate — where there is nothing to preserve and
 * leaving a deactivated row is just clutter.
 *
 * The distinction is not guessed at. The delete is attempted and the database
 * decides: a person with any history trips a foreign key and the answer comes
 * back as "deactivate instead", which is accurate by construction rather than
 * by a list of tables somebody has to remember to update.
 */
export async function deleteStaffAccount(
  targetId: number,
  actorId: number | null,
): Promise<StaffWrite> {
  const target = await get<Target>(
    "SELECT id, role, is_active FROM users WHERE id = ?",
    targetId,
  );
  if (!target) return fail(404, "NOT_FOUND");

  // Deleting the account you are signed in with is the same lockout as
  // switching it off, and less recoverable.
  if (actorId !== null && actorId === targetId) return fail(400, "SELF");

  // The Assembly needs a chairman, and deleting is even less reversible than
  // deactivating — the same guard applies, harder.
  if (target.role === "RAIS" && (await activeRaisCount()) <= 1)
    return fail(400, "LAST_RAIS");

  try {
    // Awaited inside the try on purpose: the driver reports the foreign key
    // violation by rejecting, and an unawaited call would escape this catch.
    await run("DELETE FROM users WHERE id = ?", targetId);
  } catch {
    return fail(409, "HAS_HISTORY");
  }

  publish(targetId);
  return OK;
}
