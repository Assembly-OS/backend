import { canSubmitToAi } from "../agents/access";
import { all, get, now } from "../pg";
import { projectRights } from "../project-visibility";
import { isExternal, type User } from "../types";
import { visibleSourcesSql } from "./access";
import { forget, remember } from "./sources";
import type { SourceReason, SourceStatus } from "./types";

/**
 * The document library — files staff upload for the assistant to answer
 * from, outside any project: regulations, strategies, reference tables.
 *
 * A document's words are read by the memory like every other record (kind
 * `library`), so the library row holds the file and who may see it, and the
 * source row holds how the reading went. The page joins the two.
 *
 * Anyone on the staff may add a document and chooses who may read it:
 * everyone, one project's people, one department, or only themselves. A
 * document is replaced or removed by whoever uploaded it, or by the people
 * who may hand material to the AI agents.
 */

export const VISIBILITIES = ["ALL", "PROJECT", "DEPARTMENT", "PRIVATE"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export interface LibraryDocument {
  id: number;
  title: string;
  file_key: string;
  file_name: string;
  file_size: number;
  file_mime: string;
  format: string;
  visibility: Visibility;
  project_id: number | null;
  project_code: string | null;
  department: string | null;
  version: number;
  uploaded_by: number;
  uploader_name: string;
  created_at: string;
  updated_at: string;
  /** From the memory's source row; PENDING until the first read lands. */
  status: SourceStatus;
  reason: SourceReason | null;
  text_chars: number;
  chunk_count: number;
  indexed_at: string | null;
  source_id: number | null;
}

export function canAddToLibrary(user: User): boolean {
  return !isExternal(user.role);
}

export function canManageDocument(user: User, doc: Pick<LibraryDocument, "uploaded_by">): boolean {
  return doc.uploaded_by === user.id || canSubmitToAi(user);
}

/** Whether the assistant can use a document's words at all. */
export function isAvailable(status: SourceStatus): boolean {
  return status === "READY" || status === "PARTIAL";
}

const SELECT = `
  SELECT d.*, u.full_name AS uploader_name, l.code AS project_code,
         COALESCE(s.status, 'PENDING') AS status, s.reason, COALESCE(s.text_chars, 0) AS text_chars,
         COALESCE(s.chunk_count, 0) AS chunk_count, s.indexed_at, s.id AS source_id
    FROM knowledge_documents d
    JOIN users u ON u.id = d.uploaded_by
    LEFT JOIN loyihalar l ON l.id = d.project_id
    LEFT JOIN knowledge_sources s ON s.kind = 'library' AND s.ref_id = d.id`;

/** The documents this person may read, newest first. */
export async function listDocuments(user: User): Promise<LibraryDocument[]> {
  // The library's own visibility rule is the memory's rule for kind
  // `library`; asking it through a synthetic source row keeps one copy.
  const visible = visibleSourcesSql(user, "v");
  return await all<LibraryDocument>(
    `${SELECT}
      WHERE EXISTS (SELECT 1 FROM (SELECT 'library'::text AS kind, d.id AS ref_id,
                                           NULL::int AS from_user_id, NULL::int AS to_user_id,
                                           NULL::int AS group_id, d.project_id) v
                     WHERE ${visible.sql})
      ORDER BY d.updated_at DESC, d.id DESC`,
    ...visible.params,
  );
}

export async function documentById(user: User, id: number): Promise<LibraryDocument | undefined> {
  const visible = visibleSourcesSql(user, "v");
  return await get<LibraryDocument>(
    `${SELECT}
      WHERE d.id = ?
        AND EXISTS (SELECT 1 FROM (SELECT 'library'::text AS kind, d.id AS ref_id,
                                           NULL::int AS from_user_id, NULL::int AS to_user_id,
                                           NULL::int AS group_id, d.project_id) v
                     WHERE ${visible.sql})`,
    id,
    ...visible.params,
  );
}

export interface StoredFile {
  key: string;
  name: string;
  size: number;
  mime: string;
  format: string;
}

export interface Placement {
  visibility: Visibility;
  projectId: number | null;
  department: string | null;
}

/**
 * Checks and normalises where a document goes. A project placement needs a
 * project this person can see; a department one takes the person's own
 * department unless they may see everything.
 */
export async function resolvePlacement(
  user: User,
  input: { visibility?: unknown; projectId?: number | null },
): Promise<Placement | "BAD_PROJECT" | "NO_DEPARTMENT"> {
  const visibility = (VISIBILITIES as readonly string[]).includes(String(input.visibility))
    ? (input.visibility as Visibility)
    : "ALL";
  if (visibility === "PROJECT") {
    if (!input.projectId || !(await projectRights(user, input.projectId))) return "BAD_PROJECT";
    return { visibility, projectId: input.projectId, department: null };
  }
  if (visibility === "DEPARTMENT") {
    if (!user.department) return "NO_DEPARTMENT";
    return { visibility, projectId: null, department: user.department };
  }
  return { visibility, projectId: null, department: null };
}

export async function createDocument(
  file: StoredFile,
  title: string,
  placement: Placement,
  userId: number,
): Promise<number> {
  const stamp = now();
  const row = await get<{ id: number }>(
    `INSERT INTO knowledge_documents
       (title, file_key, file_name, file_size, file_mime, format, visibility, project_id,
        department, uploaded_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
    title,
    file.key,
    file.name,
    file.size,
    file.mime,
    file.format,
    placement.visibility,
    placement.projectId,
    placement.department,
    userId,
    stamp,
    stamp,
  );
  if (!row) throw new Error("knowledge document was not created");
  await remember("library", row.id);
  return row.id;
}

/**
 * Puts a new file in place of an old one, under the same document. The
 * memory reads it again; until then the old passages still answer, which
 * is right — they are the document as it was.
 */
export async function replaceFile(
  id: number,
  file: StoredFile,
  title: string | null,
): Promise<{ previousKey: string } | null> {
  const before = await get<{ file_key: string }>(
    "SELECT file_key FROM knowledge_documents WHERE id = ?",
    id,
  );
  if (!before) return null;
  await get(
    `UPDATE knowledge_documents
        SET file_key = ?, file_name = ?, file_size = ?, file_mime = ?, format = ?,
            title = COALESCE(?, title), version = version + 1, updated_at = ?
      WHERE id = ?`,
    file.key,
    file.name,
    file.size,
    file.mime,
    file.format,
    title,
    now(),
    id,
  );
  await remember("library", id);
  return { previousKey: before.file_key };
}

export async function updatePlacement(id: number, placement: Placement, title: string | null): Promise<void> {
  await get(
    `UPDATE knowledge_documents
        SET visibility = ?, project_id = ?, department = ?, title = COALESCE(?, title), updated_at = ?
      WHERE id = ?`,
    placement.visibility,
    placement.projectId,
    placement.department,
    title,
    now(),
    id,
  );
  // The source's project column follows the placement.
  await remember("library", id);
}

/** Removes a document and everything the memory read from it. Returns the storage key. */
export async function removeDocument(id: number): Promise<string | null> {
  const row = await get<{ file_key: string }>(
    "DELETE FROM knowledge_documents WHERE id = ? RETURNING file_key",
    id,
  );
  if (!row) return null;
  await forget("library", id);
  return row.file_key;
}
