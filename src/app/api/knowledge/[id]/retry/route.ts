import { after, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import {
  canManageKnowledge,
  documentById,
  markReading,
  readDocument,
} from "@/lib/knowledge";
import { id as parseId } from "@/lib/validate";

/**
 * Reads a document again — after a key was configured, after a read was cut
 * off by a restart, or after a transient failure.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canManageKnowledge(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const documentId = parseId((await params).id);
  if (!documentId)
    return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const version = await markReading(documentId);
  if (version === null) {
    const exists = await documentById(documentId);
    return exists
      ? NextResponse.json({ error: "BUSY" }, { status: 409 })
      : NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  after(() => readDocument(documentId, version));
  return NextResponse.json({ id: documentId });
}
