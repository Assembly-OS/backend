import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { runDocumentIntake } from "@/lib/agents/intake-runner";
import { canSubmitToAi } from "@/lib/agents/access";
import {
  baseMime,
  extractSource,
  UnsupportedSource,
} from "@/lib/agents/extract";
import { safeName, store } from "@/lib/uploads";

/**
 * Per-kind ceilings. A PDF or an office file is mostly text and compresses
 * well; an image is the opposite, and the API prices it by pixels, so it gets
 * the tighter cap. All are well under the API's 32 MB request limit.
 */
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;

/**
 * Department heads, the chairman's assistant and the chairman submit a
 * document here — PDF, a photo or scan of one, Word, Excel, PowerPoint or
 * plain text. The Document Agent reads it and drafts assignments; nothing is
 * created until the sender approves each one.
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canSubmitToAi(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "BAD_FORM" }, { status: 400 });
  }

  const blob = form.get("file");
  if (!(blob instanceof File) || blob.size === 0)
    return NextResponse.json({ error: "NO_FILE" }, { status: 400 });

  const mime = baseMime(blob.type || "application/octet-stream");
  const limit = mime.startsWith("image/") ? MAX_IMAGE : MAX_BYTES;
  if (blob.size > limit)
    return NextResponse.json({ error: "TOO_LARGE", limit }, { status: 413 });

  const bytes = Buffer.from(await blob.arrayBuffer());
  if (bytes.byteLength > limit)
    return NextResponse.json({ error: "TOO_LARGE", limit }, { status: 413 });

  const name = safeName(blob.name ?? "hujjat", "file");

  // Classify and, for office formats, pull the text out. An unreadable file is
  // reported as such rather than analysed as an empty document — "no
  // assignments found" and "we could not read this" are different answers.
  let source;
  try {
    source = extractSource(bytes, mime, name);
  } catch (error) {
    if (error instanceof UnsupportedSource) {
      const reason = error.message.startsWith("UNSUPPORTED")
        ? "UNSUPPORTED_TYPE"
        : error.message === "NO_TEXT"
          ? "NO_TEXT"
          : "UNREADABLE";
      return NextResponse.json({ error: reason }, { status: 415 });
    }
    return NextResponse.json({ error: "UNREADABLE" }, { status: 415 });
  }

  // Stored so the source of any assignment can be reopened later. The run row
  // written by the intake keeps this key in `source_ref`, and
  // `/api/ai/runs/[id]/source` serves it from there.
  //
  // It used to be filed as a chat message from the uploader to themselves,
  // which is how the file became reachable — and also how every upload left a
  // conversation-with-yourself sitting at the top of that person's messages.
  // The run row already had the key; the fake message was only ever a way to
  // reach the bytes, and now there is a proper one.
  const stored = store(bytes, "file", mime, name);

  const result = await runDocumentIntake(
    user,
    bytes,
    source,
    name,
    stored.key,
  );
  return NextResponse.json({ ...result, format: source.label });
}
