import type { User } from "./types";

/**
 * Who may do what in the CRM.
 *
 * Three levels, mapped onto the roles the platform already has rather than
 * inventing a parallel set:
 *
 *  - **Admin** — the chairman and his assistant. Everything, including
 *    deleting a company and reassigning who owns a relationship.
 *  - **Manager** — department and project heads. Create and edit companies,
 *    contacts, meetings and agreements; cannot delete a company, because a
 *    company carries every meeting ever held with it and one wrong click
 *    would take the lot.
 *  - **Employee** — everyone else. Reads the directory and works their own
 *    agreements. They can close what they were made responsible for, which is
 *    the whole of their stake in it.
 *
 * Read access is deliberately open to all staff: an internal directory nobody
 * can search is a directory nobody uses, and the sensitive material (chat,
 * salaries, the admin console) lives elsewhere behind its own checks.
 */

export type CrmRole = "admin" | "manager" | "employee";

const ASSISTANT_LOGINS = (
  process.env.CRM_ADMIN_LOGINS ?? "muslimbek.komiljonov"
)
  .split(",")
  .map((login) => login.trim().toLowerCase())
  .filter(Boolean);

export function crmRole(user: User): CrmRole {
  if (user.role === "RAIS" || ASSISTANT_LOGINS.includes(user.login.toLowerCase()))
    return "admin";
  if (user.role === "BOLIM_RAHBARI" || user.role === "LOYIHA_RAHBARI")
    return "manager";
  return "employee";
}

/** Everyone signed in may read the directory. */
export function canRead(): boolean {
  return true;
}

export function canWrite(user: User): boolean {
  return crmRole(user) !== "employee";
}

export function canDelete(user: User): boolean {
  return crmRole(user) === "admin";
}

/**
 * Closing or reopening one agreement. Managers may settle anything; an
 * employee may settle what was put on them, and nothing else.
 */
export function canSettle(user: User, ownerUserId: number | null): boolean {
  return canWrite(user) || ownerUserId === user.id;
}
