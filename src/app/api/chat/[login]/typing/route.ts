import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { publishTyping } from "@/lib/events";
import { userByLogin } from "@/lib/queries";

/**
 * A keystroke ping: "I am typing to this person." Purely ephemeral — it writes
 * nothing, it just pushes a signal through the event bus so the recipient's open
 * thread can show a "typing…" line. The client throttles these to a few a second.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ login: string }> },
) {
  const { login } = await params;
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const other = userByLogin(decodeURIComponent(login));
  if (!other || other.id === user.id) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  publishTyping({ fromLogin: user.login, to: other.id });
  return new NextResponse(null, { status: 204 });
}
