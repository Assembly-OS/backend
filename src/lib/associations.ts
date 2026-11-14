import { all, get, insert, now, run, tx } from "./pg";
import { visibleProjectIds, type Viewer } from "./project-visibility";
import { isAssociationRole, isExternal, type Department, type User } from "./types";
import {
  ASSOCIATION_STATUSES,
  KONTURS,
  type AssociationStatus,
  type Kontur,
} from "./crm-stages";
import { remember } from "./knowledge/sources";

/**
 * The associations the Assembly is built on — TZ 6.1.
 *
 * Fifty of them, each with its own data space: an association's chairman
 * and representative see their own and nothing else (TZ 4.2, 4.3, kept by
 * `associationScope`), the staff see all. The record itself is the card
 * the TZ draws — four names, a sector, a contour, who answers for it on
 * each side, its member companies and the projects it takes part in.
 */

export interface Association {
  id: number;
  name: string;
  name_uzc: string | null;
  name_ru: string | null;
  name_en: string | null;
  short_name: string;
  sector: string;
  region: string;
  kontur: Kontur | null;
  responsible_user_id: number | null;
  responsible_name: string | null;
  head_user_id: number | null;
  head_login: string | null;
  head_name: string | null;
  head_position: string | null;
  head_contact: string | null;
  members_count: number;
  status: AssociationStatus;
  created_at: string;
  updated_at: string | null;
  /** Counts the card and the list show. */
  projects: number;
  companies: number;
  meetings: number;
  tasks_open: number;
}

const SELECT = `
  SELECT u.id, u.name, u.name_uzc, u.name_ru, u.name_en, u.short_name, u.sector, u.region,
         u.kontur, u.responsible_user_id, r.full_name AS responsible_name,
         u.head_user_id, h.login AS head_login, u.head_name, u.head_position, u.head_contact,
         u.members_count, u.status, u.created_at, u.updated_at,
         (SELECT COUNT(*) FROM uyushma_projects up WHERE up.uyushma_id = u.id) AS projects,
         (SELECT COUNT(*) FROM partners p WHERE p.uyushma_id = u.id) AS companies,
         (SELECT COUNT(*) FROM meetings m WHERE m.uyushma_id = u.id) AS meetings,
         (SELECT COUNT(*) FROM tasks t WHERE t.uyushma_id = u.id
             AND t.status NOT IN ('BAJARILDI','RAD_ETILDI')) AS tasks_open
    FROM uyushmalar u
    LEFT JOIN users r ON r.id = u.responsible_user_id
    LEFT JOIN users h ON h.id = u.head_user_id`;

/** The name in the reader's language, falling back to the Latin Uzbek one. */
export function associationName(
  row: Pick<Association, "name" | "name_uzc" | "name_ru" | "name_en">,
  locale: string,
): string {
  if (locale === "uzc" && row.name_uzc) return row.name_uzc;
  if (locale === "ru" && row.name_ru) return row.name_ru;
  if (locale === "en" && row.name_en) return row.name_en;
  return row.name;
}

/**
 * A WHERE fragment over `u` for the associations this person may see:
 * their own for the association roles, all of them for the staff, none for
 * an outside project lead (TZ 4.3 gives him his project, not the base).
 */
export function associationScope(user: Pick<User, "role" | "uyushma_id">): { sql: string; params: number[] } {
  if (isAssociationRole(user.role)) return { sql: "u.id = ?", params: [user.uyushma_id ?? -1] };
  if (isExternal(user.role)) return { sql: "FALSE", params: [] };
  return { sql: "TRUE", params: [] };
}

/** Who may add, edit and import associations: the CRM's writers. */
export { canWrite as canManageAssociations } from "./crm-access";

export interface AssociationFilter {
  kontur?: string | null;
  status?: string | null;
  query?: string | null;
}

export async function associations(user: User, filter: AssociationFilter = {}): Promise<Association[]> {
  const scope = associationScope(user);
  const where: string[] = [scope.sql];
  const params: (string | number)[] = [...scope.params];
  if (filter.kontur && (KONTURS as readonly string[]).includes(filter.kontur)) {
    where.push("u.kontur = ?");
    params.push(filter.kontur);
  }
  if (filter.status && (ASSOCIATION_STATUSES as readonly string[]).includes(filter.status)) {
    where.push("u.status = ?");
    params.push(filter.status);
  }
  if (filter.query?.trim()) {
    where.push("(u.name ILIKE ? OR u.name_ru ILIKE ? OR u.name_en ILIKE ? OR u.sector ILIKE ? OR u.short_name ILIKE ?)");
    const like = `%${filter.query.trim().slice(0, 80)}%`;
    params.push(like, like, like, like, like);
  }
  return await all<Association>(`${SELECT} WHERE ${where.join(" AND ")} ORDER BY u.name`, ...params);
}

export async function associationById(user: User, id: number): Promise<Association | undefined> {
  const scope = associationScope(user);
  return await get<Association>(`${SELECT} WHERE u.id = ? AND ${scope.sql}`, id, ...scope.params);
}

export interface AssociationInput {
  name: string;
  name_uzc?: string | null;
  name_ru?: string | null;
  name_en?: string | null;
  short_name?: string | null;
  sector: string;
  region?: string | null;
  kontur?: Kontur | null;
  responsible_user_id?: number | null;
  head_user_id?: number | null;
  head_name?: string | null;
  head_position?: string | null;
  head_contact?: string | null;
  members_count?: number | null;
  status?: AssociationStatus;
  project_ids?: number[];
}

/** The short name the first release required: the long one, cut, when none was given. */
function shortOf(input: AssociationInput): string {
  return (input.short_name?.trim() || input.name.trim().slice(0, 40)).slice(0, 80);
}

export async function createAssociation(input: AssociationInput, user: Viewer & { id: number }): Promise<number> {
  const id = await tx(async (q) => {
    const newId = await q.insert(
      `INSERT INTO uyushmalar (name, name_uzc, name_ru, name_en, short_name, sector, region, kontur,
                               responsible_user_id, head_user_id, head_name, head_position, head_contact,
                               members_count, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      input.name.trim(),
      input.name_uzc ?? null,
      input.name_ru ?? null,
      input.name_en ?? null,
      shortOf(input),
      input.sector.trim(),
      input.region?.trim() || "",
      input.kontur ?? null,
      input.responsible_user_id ?? null,
      input.head_user_id ?? null,
      input.head_name ?? null,
      input.head_position ?? null,
      input.head_contact ?? null,
      input.members_count ?? 0,
      input.status ?? "FAOL",
      user.id,
      now(),
      now(),
    );
    await setProjects(q, newId, input.project_ids ?? [], user);
    return newId;
  });
  void remember("uyushma", id);
  return id;
}

export async function updateAssociation(
  id: number,
  input: Partial<AssociationInput>,
  user: Viewer & { id: number },
): Promise<void> {
  const columns: string[] = [];
  const values: (string | number | null)[] = [];
  const set = (column: string, value: string | number | null | undefined) => {
    if (value === undefined) return;
    columns.push(`${column} = ?`);
    values.push(value);
  };
  set("name", input.name?.trim());
  set("name_uzc", input.name_uzc);
  set("name_ru", input.name_ru);
  set("name_en", input.name_en);
  if (input.short_name !== undefined || input.name !== undefined)
    set("short_name", input.short_name?.trim() || input.name?.trim().slice(0, 40));
  set("sector", input.sector?.trim());
  set("region", input.region);
  set("kontur", input.kontur);
  set("responsible_user_id", input.responsible_user_id);
  set("head_user_id", input.head_user_id);
  set("head_name", input.head_name);
  set("head_position", input.head_position);
  set("head_contact", input.head_contact);
  set("members_count", input.members_count);
  set("status", input.status);
  await tx(async (q) => {
    if (columns.length > 0)
      await q.run(`UPDATE uyushmalar SET ${columns.join(", ")}, updated_at = ? WHERE id = ?`, ...values, now(), id);
    if (input.project_ids) await setProjects(q, id, input.project_ids, user);
  });
  void remember("uyushma", id);
}

/** Replaces the association's project links with the ones the author may see. */
async function setProjects(
  q: { run: (sql: string, ...params: (string | number | null)[]) => Promise<void> },
  id: number,
  projectIds: number[],
  user: Viewer,
): Promise<void> {
  const allowed = await visibleProjectIds(user, projectIds);
  await q.run("DELETE FROM uyushma_projects WHERE uyushma_id = ?", id);
  for (const projectId of allowed)
    await q.run("INSERT INTO uyushma_projects (uyushma_id, project_id) VALUES (?, ?) ON CONFLICT DO NOTHING", id, projectId);
}

/* ------------------------------------------------------------------ */
/* The card                                                            */
/* ------------------------------------------------------------------ */

export interface AssociationCard extends Association {
  projectList: { id: number; code: string; name: string; phase: string | null }[];
  companyList: { id: number; name: string; stage: string; industry: string | null }[];
  meetingList: { id: number; title: string; held_at: string | null; created_at: string; agreed: string | null }[];
  taskList: { id: number; code: string; title: string; status: string; deadline: string | null; to_name: string }[];
}

export async function associationCard(user: User, id: number): Promise<AssociationCard | undefined> {
  const row = await associationById(user, id);
  if (!row) return undefined;
  const [projectList, companyList, meetingList, taskList] = await Promise.all([
    all<AssociationCard["projectList"][number]>(
      `SELECT l.id, l.code, l.name, l.phase FROM uyushma_projects up JOIN loyihalar l ON l.id = up.project_id
        WHERE up.uyushma_id = ?
        UNION SELECT l.id, l.code, l.name, l.phase FROM loyihalar l WHERE l.uyushma_id = ?
        ORDER BY code`,
      id,
      id,
    ),
    all<AssociationCard["companyList"][number]>(
      "SELECT id, name, stage, industry FROM partners WHERE uyushma_id = ? ORDER BY name LIMIT 200",
      id,
    ),
    all<AssociationCard["meetingList"][number]>(
      `SELECT id, title, held_at, created_at, agreed FROM meetings WHERE uyushma_id = ?
        ORDER BY COALESCE(held_at, created_at) DESC LIMIT 30`,
      id,
    ),
    all<AssociationCard["taskList"][number]>(
      `SELECT t.id, t.code, t.title, t.status, t.deadline, u.full_name AS to_name
         FROM tasks t JOIN users u ON u.id = t.to_user_id
        WHERE t.uyushma_id = ? ORDER BY t.id DESC LIMIT 30`,
      id,
    ),
  ]);
  return { ...row, projectList, companyList, meetingList, taskList };
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

/**
 * The fifty associations exist in the Assembly's own reference list, not in
 * any file this repository holds, so the module takes them as a CSV: one
 * association per line, the columns of the card, a header row naming them.
 * Existing names are updated rather than doubled, so the file can be
 * corrected and sent again.
 */
export const IMPORT_COLUMNS = [
  "name",
  "name_uzc",
  "name_ru",
  "name_en",
  "short_name",
  "sector",
  "kontur",
  "region",
  "head_name",
  "head_position",
  "head_contact",
  "members_count",
  "status",
] as const;

export function parseAssociationCsv(text: string): { rows: AssociationInput[]; errors: string[] } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((line) => line.trim());
  const errors: string[] = [];
  if (lines.length < 2) return { rows: [], errors: ["EMPTY"] };
  const separator = lines[0].includes(";") ? ";" : lines[0].includes("\t") ? "\t" : ",";
  const split = (line: string) => line.split(separator).map((cell) => cell.trim().replace(/^"|"$/g, ""));
  const header = split(lines[0]).map((cell) => cell.toLowerCase());
  const index = (column: string) => header.indexOf(column);
  if (index("name") < 0 || index("sector") < 0) return { rows: [], errors: ["HEADER"] };

  const rows: AssociationInput[] = [];
  lines.slice(1).forEach((line, number) => {
    const cells = split(line);
    const cell = (column: string) => {
      const at = index(column);
      return at >= 0 ? cells[at] || null : null;
    };
    const name = cell("name");
    const sector = cell("sector");
    if (!name || !sector) {
      errors.push(`line ${number + 2}: name and sector are required`);
      return;
    }
    const kontur = cell("kontur")?.toUpperCase();
    const status = cell("status")?.toUpperCase();
    rows.push({
      name,
      name_uzc: cell("name_uzc"),
      name_ru: cell("name_ru"),
      name_en: cell("name_en"),
      short_name: cell("short_name"),
      sector,
      region: cell("region"),
      kontur: kontur && (KONTURS as readonly string[]).includes(kontur) ? (kontur as Kontur) : null,
      head_name: cell("head_name"),
      head_position: cell("head_position"),
      head_contact: cell("head_contact"),
      members_count: Number(cell("members_count")) || 0,
      status: status && (ASSOCIATION_STATUSES as readonly string[]).includes(status) ? (status as AssociationStatus) : "FAOL",
    });
  });
  return { rows, errors };
}

export async function importAssociations(
  rows: AssociationInput[],
  user: Viewer & { id: number },
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const row of rows) {
    const existing = await get<{ id: number }>("SELECT id FROM uyushmalar WHERE lower(name) = lower(?)", row.name);
    if (existing) {
      await updateAssociation(existing.id, row, user);
      updated++;
    } else {
      await createAssociation(row, user);
      created++;
    }
  }
  return { created, updated };
}

/** Staff who may answer for an association, for the form's picker. */
export async function responsibleOptions(): Promise<{ id: number; full_name: string; department: Department | null }[]> {
  return await all(
    `SELECT id, full_name, department FROM users
      WHERE is_active = 1 AND role IN ('RAIS','KLASTER_RAHBARI','BOLIM_RAHBARI','LOYIHA_RAHBARI','AI_LAB','ISHCHI')
      ORDER BY full_name`,
  );
}

/** Platform accounts of association heads, for the form's picker. */
export async function headAccountOptions(): Promise<{ id: number; full_name: string; uyushma_id: number | null }[]> {
  return await all(
    `SELECT id, full_name, uyushma_id FROM users
      WHERE is_active = 1 AND role IN ('UYUSHMA_RAISI','UYUSHMA_VAKILI') ORDER BY full_name`,
  );
}

export { insert as _insert, run as _run };
