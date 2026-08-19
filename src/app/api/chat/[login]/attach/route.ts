import { NextResponse } from "next/server";
import { now, run } from "@/lib/pg";
import { currentUser } from "@/lib/session";
import { publish } from "@/lib/events";
import { thread, userByLogin } from "@/lib/queries";
import { str } from "@/lib/validate";
import {
  MAX_BYTES,
  MAX_DURATION,
  resolveKind,
  safeName,
  store,
} from "@/lib/uploads";

/**
 * Attachment upload for one conversation: `multipart/form-data` carrying the
 * blob plus an optional caption. Mirrors the JSON POST next door — same auth,
 * same publish, same "return the fresh thread" contract — so the client can
 * treat a photo and a sentence as the same kind of send.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ login: string }> },
) {
  const { login } = await params;

  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const other = await userByLogin(decodeURIComponent(login));
  if (!other) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (other.id === user.id)
    return NextResponse.json({ error: "SELF" }, { status: 400 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "BAD_FORM" }, { status: 400 });
  }

  const blob = form.get("file");
  if (!(blob instanceof File) || blob.size === 0)
    return NextResponse.json({ error: "NO_FILE" }, { status: 400 });

  // The client's `kind` is only a hint — the stored kind comes from the MIME
  // type, so an unrenderable "photo" lands as a downloadable file rather than
  // a broken image bubble.
  const hint = String(form.get("kind") ?? "file");
  const mime = blob.type || "application/octet-stream";
  const kind = resolveKind(hint, mime);

  if (blob.size > MAX_BYTES[kind])
    return NextResponse.json(
      { error: "TOO_LARGE", limit: MAX_BYTES[kind] },
      { status: 413 },
    );

  const caption = str(form.get("caption"), 4000) ?? "";

  // Recorder-reported seconds; clamped so a bogus value cannot reach the UI.
  const rawDuration = Number(form.get("duration"));
  const duration =
    kind === "voice" && Number.isFinite(rawDuration) && rawDuration > 0
      ? Math.min(Math.round(rawDuration), MAX_DURATION)
      : null;

  const bytes = new Uint8Array(await blob.arrayBuffer());
  // `blob.size` is the client's claim; this is the count that actually arrived.
  if (bytes.byteLength > MAX_BYTES[kind])
    return NextResponse.json(
      { error: "TOO_LARGE", limit: MAX_BYTES[kind] },
      { status: 413 },
    );

  const name = safeName(blob.name ?? "", kind);
  const stored = store(bytes, kind, mime, name);

  await run(
    `INSERT INTO messages
       (from_user_id, to_user_id, body, kind, file_name, file_size, file_mime, file_key, duration, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    user.id,
    other.id,
    caption,
    kind,
    name,
    stored.size,
    mime,
    stored.key,
    duration,
    now(),
  );

  publish(user.id, other.id);

  return NextResponse.json({ messages: await thread(user.id, other.id) });
}
