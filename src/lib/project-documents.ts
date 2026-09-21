import { actingAs } from "./archive";
import { all, get, now, tx } from "./pg";
import type { DocumentKind } from "./project-document-kinds";
import type { User } from "./types";

export {
  DOCUMENT_KINDS,
  isDocumentKind,
  type DocumentKind,
} from "./project-document-kinds";

/**
 * A project's documents — the master plan, the feasibility study, the ESG
 * assessment, the legal papers — the last field of the passport in TZ block
 * 1.3.
 *
 * Read by everyone who reads projects. Kept by the same people who keep the
 * project's schedule: the managers, and this project's own leader and deputy,
 * who are the ones who actually receive these papers.
 */

export interface ProjectDocument {
  id: number;
  loyiha_id: number;
  kind: DocumentKind;
  title: string;
  file_key: string;
  file_name: string;
  file_size: number;
  uploaded_by: number | null;
  uploader_name: string | null;
  created_at: string;
}

const SELECT = `
  SELECT d.*, u.full_name AS uploader_name
    FROM project_documents d
    LEFT JOIN users u ON u.id = d.uploaded_by
`;

/** Newest first: the latest version of a plan is the one people open. */
export async function documentsOf(projectId: number): Promise<ProjectDocument[]> {
  return await all<ProjectDocument>(
    `${SELECT} WHERE d.loyiha_id = ? ORDER BY d.id DESC`,
    projectId,
  );
}

export async function documentOf(
  projectId: number,
  documentId: number,
): Promise<ProjectDocument | undefined> {
  return await get<ProjectDocument>(
    `${SELECT} WHERE d.loyiha_id = ? AND d.id = ?`,
    projectId,
    documentId,
  );
}

export async function addDocument(input: {
  projectId: number;
  kind: DocumentKind;
  title: string;
  file: { key: string; name: string; size: number };
  userId: number;
}): Promise<number> {
  const row = await get<{ id: number }>(
    `INSERT INTO project_documents
       (loyiha_id, kind, title, file_key, file_name, file_size, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
    input.projectId,
    input.kind,
    input.title,
    input.file.key,
    input.file.name,
    input.file.size,
    input.userId,
    now(),
  );
  if (!row) throw new Error("project document was not created");
  return row.id;
}

/**
 * Removes a document from the project. The row goes to `archive` through the
 * trigger, attributed to whoever asked, and the file stays on disk — so a
 * document removed by mistake can be recovered.
 */
export async function removeDocument(
  projectId: number,
  documentId: number,
  userId: number,
): Promise<boolean> {
  return await tx(async (q) => {
    await actingAs(q, userId);
    const gone = await q.get<{ id: number }>(
      "DELETE FROM project_documents WHERE loyiha_id = ? AND id = ? RETURNING id",
      projectId,
      documentId,
    );
    return Boolean(gone);
  });
}
