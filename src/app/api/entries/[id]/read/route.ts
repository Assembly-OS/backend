import { NextResponse } from "next/server";
import { run } from "@/lib/pg";
import { currentUser } from "@/lib/session";
import { canWriteEntries } from "@/lib/project-access";
import { entryById } from "@/lib/project-threads";
import { read, resolvePath } from "@/lib/uploads";
import { mimeForKey, readAttachment } from "@/lib/agents/read-file";
import { id as parseId } from "@/lib/validate";

/**
 * Reads a document that was attached before anything read documents.
 *
 * Every file uploaded from now on is read as it arrives. The ones already in
 * the archive are not, and without this they never would be: the journal would
 * show them forever while the assistant kept answering, correctly and
 * uselessly, that the records contain no such document.
 *
 * Open to anyone who may write in a thread. Reading a file changes nothing
 * about it — it only moves what it already says into the part of the record
 * the assistant can see.
 */

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canWriteEntries())
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const entryId = parseId((await params).id);
  const entry = entryId ? await entryById(entryId) : undefined;
  if (!entry?.file_key || !entry.file_name)
    return NextResponse.json({ error: "NO_FILE" }, { status: 404 });

  const mime = mimeForKey(entry.file_key);
  if (!mime) return NextResponse.json({ error: "UNSUPPORTED" }, { status: 415 });

  if (!resolvePath(entry.file_key))
    return NextResponse.json({ error: "GONE" }, { status: 410 });
  const bytes = read(entry.file_key);
  if (!bytes) return NextResponse.json({ error: "GONE" }, { status: 410 });

  const text = await readAttachment(bytes, mime, entry.file_name);
  if (!text) return NextResponse.json({ ok: true, read: false });

  await run("UPDATE thread_entries SET file_text = ? WHERE id = ?", text, entry.id);
  return NextResponse.json({ ok: true, read: true, length: text.length });
}
