import { NextResponse } from "next/server";
import { get } from "@/lib/pg";
import { currentUser } from "@/lib/session";
import { canSubmitToAi } from "@/lib/agents/access";
import { parseRange, resolvePath } from "@/lib/uploads";
import { id as parseId } from "@/lib/validate";
import fs from "node:fs";

/**
 * The recording of one meeting.
 *
 * Kept out of `public/` like every other upload, so this route is the only way
 * to the bytes and re-checks on every request who is asking. A recording is
 * the rawest thing the platform holds — everything anybody said, before an
 * analysis softened it — so it is limited to the people who may see meeting
 * conclusions at all, plus whoever recorded it.
 *
 * Answers ranges because Safari will not start playing audio without one.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const meetingId = parseId((await params).id);
  if (!meetingId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const meeting = await get<{ audio_key: string | null; owner_id: number }>(
    "SELECT audio_key, owner_id FROM meetings WHERE id = ?",
    meetingId,
  );
  // Not "forbidden": someone who may not hear a meeting is told nothing about
  // whether it exists.
  if (!meeting || (!canSubmitToAi(user) && meeting.owner_id !== user.id))
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (!meeting.audio_key)
    return NextResponse.json({ error: "NO_AUDIO" }, { status: 404 });

  const path = resolvePath(meeting.audio_key);
  if (!path) return NextResponse.json({ error: "GONE" }, { status: 404 });

  const size = fs.statSync(path).size;
  const range = parseRange(request.headers.get("range"), size);
  const headers = new Headers({
    "Content-Type": "audio/webm",
    "Accept-Ranges": "bytes",
    // A recording never changes; let the browser keep it for the session.
    "Cache-Control": "private, max-age=3600",
    "Content-Disposition": `inline; filename="meeting-${meetingId}.webm"`,
  });

  if (range) {
    // Read only the requested window: a two-hour recording is tens of
    // megabytes, and a seek must not pull all of it into memory.
    const length = range.end - range.start + 1;
    const chunk = Buffer.alloc(length);
    const handle = fs.openSync(path, "r");
    try {
      fs.readSync(handle, chunk, 0, length, range.start);
    } finally {
      fs.closeSync(handle);
    }
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("Content-Length", String(chunk.byteLength));
    return new NextResponse(new Uint8Array(chunk), { status: 206, headers });
  }

  headers.set("Content-Length", String(size));
  return new NextResponse(new Uint8Array(fs.readFileSync(path)), { headers });
}
