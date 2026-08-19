import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import {
  listNotifications,
  markRead,
  sweepReminders,
  unreadCount,
} from "@/lib/notifications";
import { id as parseId } from "@/lib/validate";

/**
 * The bell.
 *
 * The read also fires any reminder that has come due. Piggy-backing the sweep
 * on a request somebody is already making means a person who has the platform
 * open never needs the bot running to be reminded — and because firing is
 * idempotent, it costs nothing when the bot got there first.
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  await sweepReminders();
  return NextResponse.json({
    unread: await unreadCount(user.id),
    notifications: await listNotifications(user.id),
  });
}

/** Mark one read, or all of them. */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { id?: unknown };
  await markRead(user.id, parseId(body.id) ?? undefined);
  return NextResponse.json({ ok: true, unread: await unreadCount(user.id) });
}
