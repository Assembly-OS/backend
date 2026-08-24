import { NextResponse } from "next/server";
import { get } from "@/lib/pg";
import { currentUser } from "@/lib/session";
import { hasAdminSession } from "@/lib/admin-auth";
import { read } from "@/lib/uploads";
import { id as parseId } from "@/lib/validate";

/**
 * Serves the file handed in with an assignment's result.
 *
 * Uploads live outside `public/`, so this route is the only way to the bytes,
 * and it re-checks the reader every time rather than trusting an unguessable
 * key: a link pasted into a chat would otherwise open the file for whoever
 * received it.
 *
 * Reach is the assignment's own reach — the person who sent it, the person
 * holding it now, and whoever the current stage names as reviewer. Everyone
 * else, including colleagues who held an earlier stage, is refused: the result
 * belongs to the task, not to the archive.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await hasAdminSession();
  const user = admin ? null : await currentUser();
  if (!admin && !user)
    return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const taskId = parseId((await params).id);
  if (!taskId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const task = await get<{
    from_user_id: number;
    to_user_id: number;
    reviewer_user_id: number | null;
    result_file_key: string | null;
    result_file_name: string | null;
  }>(
    `SELECT from_user_id, to_user_id, reviewer_user_id,
            result_file_key, result_file_name
       FROM tasks WHERE id = ?`,
    taskId,
  );

  if (!task?.result_file_key)
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  if (user) {
    const allowed =
      task.from_user_id === user.id ||
      task.to_user_id === user.id ||
      task.reviewer_user_id === user.id;
    if (!allowed)
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const bytes = read(task.result_file_key);
  // The row still points at it, the disk no longer holds it. Say gone rather
  // than serving nothing, so the difference is visible in a log.
  if (!bytes) return NextResponse.json({ error: "GONE" }, { status: 404 });

  const name = task.result_file_name ?? "natija";
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/octet-stream",
      // Always an attachment: a result is something to keep, and a file that
      // opens in the tab is a file the browser decides what to do with.
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      "Cache-Control": "private, no-store",
    },
  });
}
