import { NextResponse } from "next/server";
import { all, get, now, run } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { publish } from "@/lib/events";
import { str } from "@/lib/validate";

/**
 * Creates a group conversation. Anyone may start one and invite any active
 * colleague — the same reach the one-to-one rail already gives, where every
 * name in the directory is one click from a message.
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const body = (await request.json()) as {
    title?: unknown;
    memberIds?: unknown;
  };

  const title = str(body.title, 120);
  if (!title) return NextResponse.json({ error: "REQUIRED" }, { status: 400 });

  const requested = Array.isArray(body.memberIds)
    ? body.memberIds
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    : [];

  // Only real, active colleagues join, and the creator is always in. A group
  // of one would just be a note to self, so at least one other is required.
  const others = requested.filter((id) => id !== user.id);
  if (others.length === 0)
    return NextResponse.json({ error: "NO_MEMBERS" }, { status: 400 });

  const marks = others.map(() => "?").join(",");
  const valid = all<{ id: number }>(
    `SELECT id FROM users WHERE is_active = 1 AND id IN (${marks})`,
    ...others,
  ).map((row) => row.id);
  if (valid.length === 0)
    return NextResponse.json({ error: "NO_MEMBERS" }, { status: 400 });

  const stamp = now();
  run(
    "INSERT INTO chat_groups (title, created_by, created_at) VALUES (?,?,?)",
    title,
    user.id,
    stamp,
  );
  const group = get<{ id: number }>(
    "SELECT id FROM chat_groups WHERE created_by = ? ORDER BY id DESC LIMIT 1",
    user.id,
  )!;

  for (const memberId of [user.id, ...valid]) {
    run(
      "INSERT OR IGNORE INTO group_members (group_id, user_id, joined_at) VALUES (?,?,?)",
      group.id,
      memberId,
      stamp,
    );
  }

  // Every member's chat rail should show the new group at once.
  publish(user.id, ...valid);

  return NextResponse.json({ ok: true, id: group.id });
}
