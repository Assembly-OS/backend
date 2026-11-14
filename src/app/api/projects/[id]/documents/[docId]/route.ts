import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { projectRights } from "@/lib/project-visibility";
import { removeDocument } from "@/lib/project-documents";
import { id as parseId } from "@/lib/validate";

/** Takes a document off the project. The row and the file are kept in the archive. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; docId: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const { id, docId } = await params;
  const projectId = parseId(id);
  const documentId = parseId(docId);
  const project = projectId ? await projectRights(user, projectId) : null;
  if (!project || !documentId)
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (!project.keepDocuments)
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const removed = await removeDocument(project.id, documentId, user.id);
  if (!removed) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
