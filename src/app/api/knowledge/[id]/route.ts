import { after, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import {
  canManageKnowledge,
  readDocument,
  removeDocument,
  replaceFile,
} from "@/lib/knowledge";
import { remove, store } from "@/lib/uploads";
import { id as parseId } from "@/lib/validate";
import { parseUpload } from "../upload";

type Params = { params: Promise<{ id: string }> };

/**
 * Replaces a document's file. The document keeps its place, its title (unless
 * a new one is sent) and its links from past answers; its words are read
 * again from the new file.
 */
export async function PUT(request: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canManageKnowledge(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const documentId = parseId((await params).id);
  if (!documentId)
    return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const upload = await parseUpload(request);
  if (!upload.ok)
    return NextResponse.json({ error: upload.error }, { status: upload.status });

  const stored = store(upload.bytes, "file", upload.mime, upload.name);
  const replaced = await replaceFile(
    documentId,
    {
      key: stored.key,
      name: upload.name,
      size: stored.size,
      mime: upload.mime,
      format: upload.format,
    },
    upload.title,
  );
  if (!replaced) {
    remove(stored.key);
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  // The previous file is not kept. The library holds the current version of a
  // document, not its history.
  remove(replaced.previousKey);
  after(() => readDocument(documentId, replaced.version));
  return NextResponse.json({ id: documentId });
}

/** Removes a document: its row, its passages and its file. */
export async function DELETE(_request: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canManageKnowledge(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const documentId = parseId((await params).id);
  if (!documentId)
    return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const key = await removeDocument(documentId);
  if (!key) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  remove(key);
  return NextResponse.json({ ok: true });
}
