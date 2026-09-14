import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { documentById } from "@/lib/knowledge";
import { read } from "@/lib/uploads";
import { id as parseId } from "@/lib/validate";

/**
 * The original file behind a library document, for anyone signed in — the
 * library is shared, and being able to open the source is how an answer that
 * cites it gets checked.
 *
 * Always a download, never rendered: an uploaded HTML or SVG file must not run
 * on this origin. The strict sandbox policy for this path is set in
 * next.config.ts, which overrides headers a route returns.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const documentId = parseId((await params).id);
  if (!documentId)
    return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const document = await documentById(documentId);
  if (!document)
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const bytes = read(document.file_key);
  if (!bytes) return NextResponse.json({ error: "GONE" }, { status: 404 });

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(document.file_name)}`,
      "X-Content-Type-Options": "nosniff",
      // The same URL serves a different file after a replace.
      "Cache-Control": "private, no-cache",
      "Content-Length": String(bytes.byteLength),
    },
  });
}
