import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canWriteEntries } from "@/lib/project-access";
import { addEntry, entriesOf, threadById } from "@/lib/project-threads";
import { MAX_BYTES, resolveKind, safeName, store } from "@/lib/uploads";
import { readAttachment } from "@/lib/agents/read-file";
import { id as parseId, str } from "@/lib/validate";

/**
 * Reading further back into a thread. The page renders the recent window
 * server-side; this is what "earlier" fetches.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const threadId = parseId((await params).id);
  if (!threadId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const before = parseId(new URL(request.url).searchParams.get("before"));
  return NextResponse.json(await entriesOf(threadId, 60, before ?? undefined));
}

/**
 * Appends one record to a thread.
 *
 * Two content types, one meaning. JSON carries a written entry — a note, a
 * meeting write-up, a link, or a line pointing at the task or agreement it
 * produced. `multipart/form-data` carries the same thing with a document
 * attached, because "they sent the contract" is a sentence AND a file, and
 * splitting it into two entries would break the day it belongs to.
 *
 * What this route deliberately does NOT do is create the task or the
 * agreement itself. Those have their own endpoints, already written, already
 * carrying notifications, chains and reminders; the client calls them and
 * hands the resulting id back here. Reimplementing either would have produced
 * a second, quietly divergent way to assign work.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canWriteEntries())
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const threadId = parseId((await params).id);
  const thread = threadId ? await threadById(threadId) : undefined;
  if (!thread) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const type = request.headers.get("content-type") ?? "";

  if (type.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return NextResponse.json({ error: "BAD_FORM" }, { status: 400 });
    }

    const blob = form.get("file");
    if (!(blob instanceof File) || blob.size === 0)
      return NextResponse.json({ error: "NO_FILE" }, { status: 400 });

    // The MIME type decides, not the client's hint: an unrenderable "photo"
    // must land as a document rather than as a broken image.
    const mime = blob.type || "application/octet-stream";
    const kind = resolveKind(String(form.get("kind") ?? "file"), mime);
    if (blob.size > MAX_BYTES[kind])
      return NextResponse.json(
        { error: "TOO_LARGE", limit: MAX_BYTES[kind] },
        { status: 413 },
      );

    const bytes = new Uint8Array(await blob.arrayBuffer());
    // `blob.size` is a claim; this is what actually arrived.
    if (bytes.byteLength > MAX_BYTES[kind])
      return NextResponse.json(
        { error: "TOO_LARGE", limit: MAX_BYTES[kind] },
        { status: 413 },
      );

    const name = safeName(blob.name ?? "", kind);
    const stored = store(bytes, kind, mime, name);

    // Read now, while the bytes are in hand. A document nobody has read is
    // not in the project's memory — the journal shows a filename and the
    // assistant, asked what it said, correctly answers that no such record
    // exists. Awaited rather than fired and forgotten: the upload is slower
    // by the length of one read, and in exchange the file is searchable the
    // moment it appears instead of at some unpredictable later point.
    // A failure is not fatal — the entry is filed either way.
    const fileText = await readAttachment(Buffer.from(bytes), mime, name);

    const id = await addEntry(thread.id, user.id, {
      kind: "FILE",
      body: str(form.get("body"), 8000) ?? "",
      occurredOn: form.get("occurredOn"),
      fileKey: stored.key,
      fileName: name,
      fileSize: stored.size,
      fileText,
    });
    return NextResponse.json({ ok: true, id, read: Boolean(fileText) });
  }

  const body = (await request.json()) as Record<string, unknown>;
  const text = str(body.body, 8000);
  const link = str(body.linkUrl, 500);
  const taskId = body.taskId == null ? null : parseId(body.taskId);
  const agreementId =
    body.agreementId == null ? null : parseId(body.agreementId);

  // An entry with nothing in it and nothing attached to it is a blank line in
  // the history, which is worse than no line.
  if (!text && !link && !taskId && !agreementId)
    return NextResponse.json({ error: "EMPTY" }, { status: 400 });

  const id = await addEntry(thread.id, user.id, {
    kind: body.kind,
    body: text ?? "",
    occurredOn: body.occurredOn,
    linkUrl: link,
    meetingId: body.meetingId == null ? null : parseId(body.meetingId),
    agreementId,
    taskId,
  });

  return NextResponse.json({ ok: true, id });
}
