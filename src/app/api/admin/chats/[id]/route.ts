import { NextResponse } from "next/server";
import { run } from "@/lib/db";
import { hasAdminSession } from "@/lib/admin-auth";
import { messageFileKey } from "@/lib/admin";
import { publish } from "@/lib/events";
import { remove } from "@/lib/uploads";
import { id as parseId } from "@/lib/validate";

/**
 * Removes one message. Unlike a staff account — which is deactivated so the
 * audit trail keeps its shape — a message has nothing pointing at it, so the
 * row really goes, along with the attachment blob it owned. This is the one
 * destructive control the panel offers over chat.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await hasAdminSession()))
    return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const messageId = parseId((await params).id);
  if (!messageId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  // Read the key before the row disappears, or the file is orphaned on disk.
  const key = messageFileKey(messageId);
  const result = run("DELETE FROM messages WHERE id = ?", messageId);
  if (Number(result.changes) === 0)
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  if (key) remove(key);

  // Both participants' open threads and unread counters refresh at once.
  publish();

  return NextResponse.json({ ok: true });
}
