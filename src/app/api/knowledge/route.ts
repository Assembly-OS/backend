import { after, NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import {
  canManageKnowledge,
  createDocument,
  readDocument,
} from "@/lib/knowledge";
import { store } from "@/lib/uploads";
import { defaultTitle, parseUpload } from "./upload";

/**
 * Adds a document to the library.
 *
 * Answers as soon as the file is stored. Reading a long PDF takes a minute or
 * more, and nobody should hold a spinner that long: the document appears in
 * the list at once as "being read", and the read finishes after the response.
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canManageKnowledge(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const upload = await parseUpload(request);
  if (!upload.ok)
    return NextResponse.json({ error: upload.error }, { status: upload.status });

  const stored = store(upload.bytes, "file", upload.mime, upload.name);
  const { id, version } = await createDocument(
    {
      key: stored.key,
      name: upload.name,
      size: stored.size,
      mime: upload.mime,
      format: upload.format,
    },
    upload.title ?? defaultTitle(upload.name),
    user.id,
  );

  after(() => readDocument(id, version));
  return NextResponse.json({ id }, { status: 201 });
}
