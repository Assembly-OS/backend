import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { documentOf } from "@/lib/project-documents";
import { read } from "@/lib/uploads";
import { id as parseId } from "@/lib/validate";

/**
 * Downloads one project document, for anyone who reads projects. Always an
 * attachment; the sandbox policy for this path is set in next.config.ts.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; docId: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const { id, docId } = await params;
  const projectId = parseId(id);
  const documentId = parseId(docId);
  const document =
    projectId && documentId ? await documentOf(projectId, documentId) : undefined;
  if (!document) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const bytes = read(document.file_key);
  if (!bytes) return NextResponse.json({ error: "GONE" }, { status: 404 });

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(document.file_name)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600",
      "Content-Length": String(bytes.byteLength),
    },
  });
}
