import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { hasAdminSession } from "@/lib/admin-auth";
import { attachment, isGroupMember } from "@/lib/queries";
import { isInline, parseRange, read } from "@/lib/uploads";
import { id as parseId } from "@/lib/validate";

/**
 * Serves one chat attachment, addressed by the id of the message that carries
 * it. Attachments are stored outside `public/`, so this route is the only way
 * to reach the bytes — and it re-checks that the reader is one of the two
 * people in the conversation on every request.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // Either door opens this: the separate administration session used by the
  // oversight panel, or a participant's own session. Admin is checked first so
  // it still works in a browser that is also signed in as some employee.
  const admin = await hasAdminSession();
  const user = admin ? null : await currentUser();
  if (!admin && !user)
    return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const messageId = parseId((await params).id);
  if (!messageId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const row = await attachment(messageId);
  if (!row?.file_key)
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  // Reach is exactly the reach of the conversation the file was sent in: the
  // two people in a one-to-one thread, or the members of a group. The
  // administrator is the deliberate exception, with no staff identity to
  // compare against.
  if (user) {
    const allowed = row.group_id
      ? await isGroupMember(row.group_id, user.id)
      : row.from_user_id === user.id || row.to_user_id === user.id;
    if (!allowed)
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const bytes = read(row.file_key);
  if (!bytes) return NextResponse.json({ error: "GONE" }, { status: 404 });

  const mime = row.file_mime ?? "application/octet-stream";
  const inline = isInline(row.kind, mime);
  const name = row.file_name ?? "file";

  const headers: Record<string, string> = {
    // Only allow-listed image/audio types are echoed back. Anything else is
    // served as an opaque download, so an uploaded HTML or SVG document can
    // never execute on this origin.
    "Content-Type": inline ? mime : "application/octet-stream",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`,
    // Belt and braces around the type decision above. The matching
    // `default-src 'none'; sandbox` CSP is set in next.config.ts, which is
    // authoritative for this path — a header set here would be overridden.
    "X-Content-Type-Options": "nosniff",
    // Private, but immutable: a stored blob never changes under its id, so a
    // re-render or a scroll-back replays it from cache instead of the disk.
    "Cache-Control": "private, max-age=31536000, immutable",
    "Accept-Ranges": "bytes",
  };

  const range = parseRange(request.headers.get("range"), bytes.byteLength);
  if (range) {
    const slice = bytes.subarray(range.start, range.end + 1);
    return new Response(new Uint8Array(slice), {
      status: 206,
      headers: {
        ...headers,
        "Content-Length": String(slice.byteLength),
        "Content-Range": `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
      },
    });
  }

  return new Response(new Uint8Array(bytes), {
    headers: { ...headers, "Content-Length": String(bytes.byteLength) },
  });
}
