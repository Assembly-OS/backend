import { NextResponse } from "next/server";
import { hasAdminSession } from "@/lib/admin-auth";
import { conversation, groupConversation } from "@/lib/admin";
import { id as parseId } from "@/lib/validate";

/**
 * Reads one conversation for the oversight panel: `?a=<id>&b=<id>`.
 * The administrator is not a participant, so the ordinary chat endpoint would
 * refuse — this route exists precisely to allow that, and nothing but a valid
 * administration session opens it.
 */
export async function GET(request: Request) {
  if (!(await hasAdminSession()))
    return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const params = new URL(request.url).searchParams;

  // `?group=<id>` reads a group; `?a=&b=` reads a one-to-one thread.
  const groupId = parseId(params.get("group"));
  if (groupId)
    return NextResponse.json({ messages: await groupConversation(groupId) });

  const a = parseId(params.get("a"));
  const b = parseId(params.get("b"));
  if (!a || !b || a === b)
    return NextResponse.json({ error: "BAD_PAIR" }, { status: 400 });

  return NextResponse.json({ messages: await conversation(a, b) });
}
