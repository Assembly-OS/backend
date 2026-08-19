import { NextResponse } from "next/server";
import { now, run } from "@/lib/pg";
import { currentUser } from "@/lib/session";
import { publish } from "@/lib/events";
import {
  groupMembers,
  groupThread,
  isGroupMember,
  markGroupRead,
} from "@/lib/queries";
import { id as parseId, str } from "@/lib/validate";
import {
  MAX_BYTES,
  MAX_DURATION,
  resolveKind,
  safeName,
  store,
} from "@/lib/uploads";

/**
 * Attachment upload into a group. Same contract and same limits as the
 * one-to-one endpoint next door — only the address differs, so the client can
 * send a photo to a group exactly the way it sends one to a person.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const groupId = parseId((await params).id);
  if (!groupId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });
  if (!(await isGroupMember(groupId, user.id)))
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "BAD_FORM" }, { status: 400 });
  }

  const blob = form.get("file");
  if (!(blob instanceof File) || blob.size === 0)
    return NextResponse.json({ error: "NO_FILE" }, { status: 400 });

  const hint = String(form.get("kind") ?? "file");
  const mime = blob.type || "application/octet-stream";
  const kind = resolveKind(hint, mime);

  if (blob.size > MAX_BYTES[kind])
    return NextResponse.json(
      { error: "TOO_LARGE", limit: MAX_BYTES[kind] },
      { status: 413 },
    );

  const caption = str(form.get("caption"), 4000) ?? "";
  const rawDuration = Number(form.get("duration"));
  const duration =
    kind === "voice" && Number.isFinite(rawDuration) && rawDuration > 0
      ? Math.min(Math.round(rawDuration), MAX_DURATION)
      : null;

  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES[kind])
    return NextResponse.json(
      { error: "TOO_LARGE", limit: MAX_BYTES[kind] },
      { status: 413 },
    );

  const name = safeName(blob.name ?? "", kind);
  const stored = store(bytes, kind, mime, name);

  await run(
    `INSERT INTO messages
       (from_user_id, group_id, body, kind, file_name, file_size, file_mime, file_key, duration, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    user.id,
    groupId,
    caption,
    kind,
    name,
    stored.size,
    mime,
    stored.key,
    duration,
    now(),
  );

  await markGroupRead(groupId, user.id);
  publish(...(await groupMembers(groupId)).map((member) => member.id));

  return NextResponse.json({ messages: await groupThread(groupId) });
}
