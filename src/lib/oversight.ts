import type { User } from "./types";

/**
 * Who sees the whole Assembly rather than their own corner of it.
 *
 * The chairman, and whoever works as his hands. That second part is a list of
 * logins rather than a role because it is not one: the assistant carries
 * `BOLIM_RAHBARI` like every other head, and giving the role this reach would
 * hand it to five people who should not have it. A person, named, is the
 * honest way to say "this one, because of what they do for the chairman".
 *
 * `CRM_ADMIN_LOGINS` already carried exactly this list for the CRM. Rather
 * than start a second one that would drift from the first, both read from
 * here.
 *
 * What it opens: the organisation-wide figures — who is working on what, which
 * department is behind — and the whole staff list when placing work. Both are
 * the post itself. The assistant is asked where things stand and told to put
 * work somewhere, and a view of five heads out of fourteen answers neither.
 *
 * What it does not open: the administration panel, which has its own account
 * and its own door — staff administration reaches the platform separately,
 * see `canManageStaff` — and withdrawing an assignment somebody else sent,
 * which remains the chairman's.
 */
const ASSISTANT_LOGINS = (
  process.env.CRM_ADMIN_LOGINS ?? "muslimbek.komiljonov"
)
  .split(",")
  .map((login) => login.trim().toLowerCase())
  .filter(Boolean);

export function isAssistant(user: User): boolean {
  return ASSISTANT_LOGINS.includes(user.login.toLowerCase());
}

/** The chairman's own view of the Assembly, and his assistant's. */
export function seesEverything(user: User): boolean {
  return user.role === "RAIS" || isAssistant(user);
}

/**
 * Whose finished work a manager may open from the report, task by task.
 *
 * The report's counts reach every manager, and a count gives nothing away. The
 * titles behind it do: what another department is working on is not every
 * head's business. So the list opens for the whole Assembly's view, for the
 * person themselves, and for their direct manager — the same line the team
 * page draws.
 */
export function seesWorkOf(
  viewer: User,
  person: Pick<User, "id" | "manager_id">,
): boolean {
  return (
    seesEverything(viewer) ||
    viewer.id === person.id ||
    person.manager_id === viewer.id
  );
}

/**
 * Staff administration: adding a colleague, issuing a login and a password,
 * correcting a title, switching access off.
 *
 * The `/admin` panel could always do this, but it is a locked cupboard whose
 * key lives in the server's environment — meant for recovering the install,
 * not for the Tuesday morning when somebody joins. Onboarding is ordinary
 * work, and it belongs with the two people who actually do it.
 *
 * Separate from `seesEverything` only in name, and deliberately: the call
 * sites read as what they permit, and if issuing credentials ever needs a
 * narrower list than seeing the figures, this is the seam to narrow.
 */
export function canManageStaff(user: User): boolean {
  return seesEverything(user);
}
