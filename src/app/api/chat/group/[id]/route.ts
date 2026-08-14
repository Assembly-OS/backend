import { NextResponse } from "next/server";
import { now, run } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { publish } from "@/lib/events";
import {
  groupMembers,
  groupThread,
  isGroupMember,
  markGroupRead,
  THREAD_PAGE,
} from "@/lib/queries";
import { id as parseId, str } from "@/lib/validate";

/** Resolves the group and confirms the caller is in it. */
async function resolve(idParam: string) {
  const user = await currentUser();
  if (!user) return { error: NextResponse.json({ error: "AUTH" }, { status: 401 }) };

  const groupId = parseId(idParam);
  if (!groupId)
    return { error: NextResponse.json({ error: "BAD_ID" }, { status: 400 }) };

  // Membership is the whole access rule: a group is private to its members,
  // and non-members are told nothing beyond "not found".
  if (!isGroupMember(groupId, user.id))
    return {
      error: NextResponse.json({ error: "NOT_FOUND" }, { status: 404 }),
    };

  return { user, groupId };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const resolved = await resolve((await params).id);
  if (resolved.error) return resolved.error;
  const { user, groupId } = resolved;

  // `?before=<id>` is a scroll-back: history, so it must not move the read mark.
  const before = Number(new URL(request.url).searchParams.get("before")) || undefined;
  if (!before && markGroupRead(groupId, user.id)) publish(user.id);

  const messages = groupThread(groupId, { before });
  return NextResponse.json({
    messages,
    hasMore: messages.length === THREAD_PAGE,
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const resolved = await resolve((await params).id);
  if (resolved.error) return resolved.error;
  const { user, groupId } = resolved;

  const { body } = (await request.json()) as { body?: unknown };
  const text = str(body, 4000);
  if (!text) return NextResponse.json({ error: "EMPTY" }, { status: 400 });

  run(
    "INSERT INTO messages (from_user_id, group_id, body, created_at) VALUES (?,?,?,?)",
    user.id,
    groupId,
    text,
    now(),
  );

  // The sender has by definition read their own message.
  markGroupRead(groupId, user.id);
  publish(...groupMembers(groupId).map((member) => member.id));

  return NextResponse.json({ messages: groupThread(groupId) });
}
