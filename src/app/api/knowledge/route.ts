import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import {
  canAddToLibrary,
  createDocument,
  listDocuments,
  resolvePlacement,
} from "@/lib/knowledge/library";
import { store } from "@/lib/uploads";
import { id as parseId } from "@/lib/validate";
import { defaultTitle, parseUpload } from "./upload";

/** The library as this person may read it. */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  return NextResponse.json({ documents: await listDocuments(user) });
}

/**
 * Adds a document to the library.
 *
 * Answers as soon as the file is stored: the memory reads it afterwards,
 * and the document appears in the list at once as "waiting to be read".
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canAddToLibrary(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const upload = await parseUpload(request);
  if (!upload.ok)
    return NextResponse.json({ error: upload.error }, { status: upload.status });

  const placement = await resolvePlacement(user, {
    visibility: upload.visibility,
    projectId: upload.projectId ? parseId(upload.projectId) : null,
  });
  if (typeof placement === "string")
    return NextResponse.json({ error: placement }, { status: 400 });

  const stored = store(upload.bytes, "file", upload.mime, upload.name);
  const id = await createDocument(
    {
      key: stored.key,
      name: upload.name,
      size: stored.size,
      mime: upload.mime,
      format: upload.format,
    },
    upload.title ?? defaultTitle(upload.name),
    placement,
    user.id,
  );
  return NextResponse.json({ id }, { status: 201 });
}
