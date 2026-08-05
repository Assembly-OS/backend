import { NextResponse } from "next/server";
import { now, run } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { publish } from "@/lib/events";
import { thread, THREAD_PAGE, userByLogin } from "@/lib/queries";
import { str } from "@/lib/validate";

async function resolve(loginParam: string) {
  const user = await currentUser();
  if (!user) return { error: NextResponse.json({ error: "AUTH" }, { status: 401 }) };
  const other = userByLogin(decodeURIComponent(loginParam));
  if (!other)
    return { error: NextResponse.json({ error: "NOT_FOUND" }, { status: 404 }) };
  if (other.id === user.id)
    return { error: NextResponse.json({ error: "SELF" }, { status: 400 }) };
  return { user, other };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ login: string }> },
) {
  const { login } = await params;
  const resolved = await resolve(login);
  if (resolved.error) return resolved.error;
  const { user, other } = resolved;

  // `?before=<id>` fetches an older page (lazy scroll-back) and must not touch
  // read state — you are loading history, not opening the conversation.
  const before = Number(new URL(request.url).searchParams.get("before")) || undefined;

  if (!before) {
    const marked = run(
      "UPDATE messages SET read_at = ? WHERE to_user_id = ? AND from_user_id = ? AND read_at IS NULL",
      now(),
      user.id,
      other.id,
    );
    // Clearing the unread badge is a change the reader's other tabs and the
    // sidebar count should reflect at once.
    if (Number(marked.changes) > 0) publish(user.id);
  }

  const messages = thread(user.id, other.id, { before });
  return NextResponse.json({
    messages,
    hasMore: messages.length === THREAD_PAGE,
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ login: string }> },
) {
  const { login } = await params;
  const resolved = await resolve(login);
  if (resolved.error) return resolved.error;
  const { user, other } = resolved;

  const { body } = (await request.json()) as { body?: unknown };
  const text = str(body, 4000);
  if (!text) return NextResponse.json({ error: "EMPTY" }, { status: 400 });

  run(
    "INSERT INTO messages (from_user_id, to_user_id, body, created_at) VALUES (?,?,?,?)",
    user.id,
    other.id,
    text,
    now(),
  );

  // The recipient's open thread, chat list and unread badge update instantly.
  publish(user.id, other.id);

  return NextResponse.json({ messages: thread(user.id, other.id) });
}
