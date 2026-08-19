import { NextResponse } from "next/server";
import { get } from "@/lib/pg";
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
  const key = await messageFileKey(messageId);
  // RETURNING stands in for the changed-row count SQLite handed back: the 404
  // turns on whether a row was there, and run() no longer reports that.
  const deleted = await get<{ id: number }>(
    "DELETE FROM messages WHERE id = ? RETURNING id",
    messageId,
  );
  if (!deleted)
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  if (key) remove(key);

  // Both participants' open threads and unread counters refresh at once.
  publish();

  return NextResponse.json({ ok: true });
}
