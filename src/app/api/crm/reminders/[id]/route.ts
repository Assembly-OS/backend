import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { dismissReminder } from "@/lib/crm";
import { id as parseId } from "@/lib/validate";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  const reminderId = parseId((await params).id);
  if (!reminderId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });
  // Scoped to the owner inside the query — one person cannot clear another's.
  await dismissReminder(reminderId, user.id);
  return NextResponse.json({ ok: true });
}
