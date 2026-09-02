import { get, insert, now, run } from "./pg";
import { hashPassword } from "./auth";
import { publish } from "./events";
import { activeRaisCount, loginTaken, LOGIN_PATTERN, MIN_PASSWORD } from "./admin";
import { id as parseId, oneOf, str } from "./validate";
import { DEPARTMENTS, ROLES, type Department, type Role } from "./types";
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
  const department = DEPARTMENTS.includes(body.department as Department)
    ? (body.department as Department)
    : null;
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

  // RETURNING rather than a follow-up SELECT: the id comes back with the write,
  // and one round trip fewer counts now that the database is over a socket.
  const created = await insert(
    `INSERT INTO users (login, password_hash, full_name, role, department, position,
                        manager_id, phone, email, lang, is_active, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`,
    login,
    hashPassword(password),
    fullName,
    role,
    department,
    position,
    manager,
    phone,
    email,
    lang,
    now(),
  );

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

    const department = DEPARTMENTS.includes(body.department as Department)
      ? (body.department as Department)
      : null;
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

    await run(
      `UPDATE users SET full_name = ?, role = ?, department = ?, position = ?,
                        manager_id = ?, phone = ?, email = ?
        WHERE id = ?`,
      fullName,
      role,
      department,
      str(body.position, 160),
      manager,
      str(body.phone, 40),
      str(body.email, 120),
      targetId,
    );
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
