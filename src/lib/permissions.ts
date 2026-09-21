import type { Role, User } from "./types";

/**
 * The permission table of TZ 4.2, as data.
 *
 * Until block 4 the answer to "who may see this" was written out wherever the
 * question came up — `canWrite` here, `role === "RAIS"` there, an owner check
 * inline in three pages — and the audit's finding 19 was exactly that: six
 * roles, and nowhere that said what any of them may do. So the table the TZ
 * printed is the table the code reads. The settings page renders this same
 * object, which is how "the table works and is visible in settings" stays one
 * fact rather than two that drift.
 *
 * No database import: the settings page, the tests and the client forms all
 * read it. Scoping a query to a reach is `project-visibility.ts`'s job.
 */

/** The table's columns. A role maps onto one of them, see `columnOf`. */
export const COLUMNS = [
  "RAIS",
  "BOLIM",
  "KLASTER",
  "LOYIHA",
  "XODIM",
  "TASHQI",
  "UYUSHMA",
] as const;
export type Column = (typeof COLUMNS)[number];

/**
 * How far a permission reaches. `yes` is the table's tick — within what the
 * person can see at all, since nobody edits a project they cannot open.
 *  - `department` — projects someone in the head's department is attached to
 *  - `cluster` — projects of the cluster head's cluster
 *  - `own` / `attached` — projects the person leads or is attached to
 *  - `team` — the person's own team
 *  - `grant` — only once the chairman has switched it on for that person
 */
export type Reach =
  | "yes"
  | "department"
  | "cluster"
  | "own"
  | "attached"
  | "team"
  | "grant"
  | "no";

export const CAPABILITIES = [
  "viewProjects",
  "editPassport",
  "enterStageStatus",
  "createMeeting",
  "createKelishuv",
  "assignTasks",
  "viewOthersKpi",
  "globalAi",
  "ownAi",
  "manageStaff",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** TZ 4.2, row by row, in the order it is printed. */
export const PERMISSIONS: Record<Capability, Record<Column, Reach>> = {
  viewProjects: {
    RAIS: "yes",
    BOLIM: "department",
    KLASTER: "cluster",
    LOYIHA: "own",
    XODIM: "attached",
    TASHQI: "own",
    UYUSHMA: "no",
  },
  editPassport: {
    RAIS: "yes",
    BOLIM: "yes",
    KLASTER: "yes",
    LOYIHA: "own",
    XODIM: "no",
    TASHQI: "no",
    UYUSHMA: "no",
  },
  enterStageStatus: {
    RAIS: "yes",
    BOLIM: "yes",
    KLASTER: "yes",
    LOYIHA: "yes",
    XODIM: "no",
    TASHQI: "own",
    UYUSHMA: "no",
  },
  createMeeting: {
    RAIS: "yes",
    BOLIM: "yes",
    KLASTER: "yes",
    LOYIHA: "yes",
    XODIM: "yes",
    TASHQI: "no",
    UYUSHMA: "own",
  },
  createKelishuv: {
    RAIS: "yes",
    BOLIM: "yes",
    KLASTER: "yes",
    LOYIHA: "own",
    XODIM: "no",
    TASHQI: "no",
    UYUSHMA: "no",
  },
  assignTasks: {
    RAIS: "yes",
    BOLIM: "yes",
    KLASTER: "yes",
    LOYIHA: "team",
    XODIM: "no",
    TASHQI: "no",
    UYUSHMA: "no",
  },
  viewOthersKpi: {
    RAIS: "yes",
    BOLIM: "department",
    KLASTER: "cluster",
    LOYIHA: "team",
    XODIM: "no",
    TASHQI: "no",
    UYUSHMA: "no",
  },
  globalAi: {
    RAIS: "yes",
    BOLIM: "grant",
    KLASTER: "cluster",
    LOYIHA: "no",
    XODIM: "no",
    TASHQI: "no",
    UYUSHMA: "no",
  },
  ownAi: {
    RAIS: "yes",
    BOLIM: "yes",
    KLASTER: "yes",
    LOYIHA: "yes",
    XODIM: "yes",
    TASHQI: "own",
    UYUSHMA: "own",
  },
  manageStaff: {
    RAIS: "yes",
    BOLIM: "no",
    KLASTER: "no",
    LOYIHA: "no",
    XODIM: "no",
    TASHQI: "no",
    UYUSHMA: "no",
  },
};

/**
 * Which column a role reads.
 *
 * Two mappings the TZ leaves implicit. AI Lab has a row in 4.1 but no column
 * in 4.2; its head runs a department like any other, so it reads the
 * department column (and the audit journal, 4.4, opens to it by name). Both
 * association roles read the association column — the chairman's extra
 * overview of his own association is added where it is shown, not here.
 */
const ROLE_COLUMN: Record<Role, Column> = {
  RAIS: "RAIS",
  KLASTER_RAHBARI: "KLASTER",
  BOLIM_RAHBARI: "BOLIM",
  AI_LAB: "BOLIM",
  LOYIHA_RAHBARI: "LOYIHA",
  ISHCHI: "XODIM",
  TASHQI_LOYIHA_RAHBARI: "TASHQI",
  UYUSHMA_RAISI: "UYUSHMA",
  UYUSHMA_VAKILI: "UYUSHMA",
};

export function columnOf(role: Role): Column {
  return ROLE_COLUMN[role];
}

/**
 * The chairman's assistant, by login — see `oversight.ts` for why a named
 * person and not a role. Kept here, free of other imports, so this module
 * stays loadable by the tests and by client code.
 */
const ASSISTANT_LOGINS = (
  process.env.CRM_ADMIN_LOGINS ?? "muslimbek.komiljonov"
)
  .split(",")
  .map((login) => login.trim().toLowerCase())
  .filter(Boolean);

export function isAssistant(user: Pick<User, "login">): boolean {
  return ASSISTANT_LOGINS.includes(user.login.toLowerCase());
}

/** The chairman's own view of the Assembly, and his assistant's. */
export function seesEverything(user: Pick<User, "role" | "login">): boolean {
  return user.role === "RAIS" || isAssistant(user);
}

/**
 * The column a person reads. The chairman's assistant reads the chairman's,
 * as everywhere else on the platform (`seesEverything`): the post is to act
 * for him, and a narrower view would make it impossible.
 */
export function columnFor(user: Pick<User, "role" | "login">): Column {
  return seesEverything(user) ? "RAIS" : columnOf(user.role);
}

/** How far `capability` reaches for this person. */
export function reach(
  user: Pick<User, "role" | "login">,
  capability: Capability,
): Reach {
  return PERMISSIONS[capability][columnFor(user)];
}

/** Whether the person has `capability` at any reach. */
export function may(
  user: Pick<User, "role" | "login">,
  capability: Capability,
): boolean {
  return reach(user, capability) !== "no";
}
