import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canManageDocument, documentById } from "@/lib/knowledge/library";
import { remember } from "@/lib/knowledge/sources";
import { retrySource } from "@/lib/knowledge/sources";
import { id as parseId } from "@/lib/validate";

/**
 * Reads a document again — after a key was configured, after a read was
 * cut off by a restart, or after a transient failure.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const documentId = parseId((await params).id);
  const document = documentId ? await documentById(user, documentId) : undefined;
  if (!document) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (!canManageDocument(user, document))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  if (document.source_id) await retrySource(document.source_id);
  else await remember("library", document.id);
  return NextResponse.json({ id: document.id });
}
