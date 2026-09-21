import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { projectById } from "@/lib/project-threads";
import { canKeepDocuments, removeDocument } from "@/lib/project-documents";
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
  const project = projectId ? await projectById(projectId) : undefined;
  if (!project || !documentId)
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (!canKeepDocuments(user, project))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const removed = await removeDocument(project.id, documentId, user.id);
  if (!removed) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
