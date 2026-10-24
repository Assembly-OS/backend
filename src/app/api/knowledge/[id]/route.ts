import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import {
  canManageDocument,
  documentById,
  removeDocument,
  replaceFile,
  resolvePlacement,
  updatePlacement,
} from "@/lib/knowledge/library";
import { remove, store } from "@/lib/uploads";
import { id as parseId, str } from "@/lib/validate";
import { parseUpload } from "../upload";

type Params = { params: Promise<{ id: string }> };

async function owned(idParam: string) {
  const user = await currentUser();
  if (!user) return { error: NextResponse.json({ error: "AUTH" }, { status: 401 }) };
  const documentId = parseId(idParam);
  const document = documentId ? await documentById(user, documentId) : undefined;
  // A document this person may not read does not exist for them.
  if (!document) return { error: NextResponse.json({ error: "NOT_FOUND" }, { status: 404 }) };
  if (!canManageDocument(user, document))
    return { error: NextResponse.json({ error: "FORBIDDEN" }, { status: 403 }) };
  return { user, document };
}

/**
 * Replaces a document's file. The document keeps its place, its title
 * (unless a new one is sent) and its links from past answers; the memory
 * reads the new file.
 */
export async function PUT(request: Request, { params }: Params) {
  const resolved = await owned((await params).id);
  if (resolved.error) return resolved.error;

  const upload = await parseUpload(request);
  if (!upload.ok)
    return NextResponse.json({ error: upload.error }, { status: upload.status });

  const stored = store(upload.bytes, "file", upload.mime, upload.name);
  const replaced = await replaceFile(
    resolved.document.id,
    { key: stored.key, name: upload.name, size: stored.size, mime: upload.mime, format: upload.format },
    upload.title,
  );
  if (!replaced) {
    remove(stored.key);
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  // The library holds the current version of a document, not its history.
  remove(replaced.previousKey);
  return NextResponse.json({ id: resolved.document.id });
}

/** Changes who may read a document, or its title. */
export async function PATCH(request: Request, { params }: Params) {
  const resolved = await owned((await params).id);
  if (resolved.error) return resolved.error;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const placement = await resolvePlacement(resolved.user, {
    visibility: body.visibility ?? resolved.document.visibility,
    projectId: body.projectId == null ? resolved.document.project_id : parseId(body.projectId),
  });
  if (typeof placement === "string")
    return NextResponse.json({ error: placement }, { status: 400 });

  await updatePlacement(resolved.document.id, placement, str(body.title, 200));
  return NextResponse.json({ ok: true });
}

/** Removes a document: its row, its passages and its file. */
export async function DELETE(_request: Request, { params }: Params) {
  const resolved = await owned((await params).id);
  if (resolved.error) return resolved.error;

  const key = await removeDocument(resolved.document.id);
  if (!key) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  remove(key);
  return NextResponse.json({ ok: true });
}
