import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canManageProjects } from "@/lib/project-access";
import { archiveThread, threadById, updateThread } from "@/lib/project-threads";
import { id as parseId, str } from "@/lib/validate";

/**
 * Renaming a thread, moving it onto a company, rewriting the line that says
 * where it stands — or archiving it.
 *
 * There is no DELETE next to this on purpose. A finished counterpart is
 * precisely the thread somebody reads two years later to find out what was
 * actually agreed, so the only way out of the sidebar keeps every word.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canManageProjects(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const threadId = parseId((await params).id);
  const thread = threadId ? await threadById(threadId) : undefined;
  if (!thread) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const body = (await request.json()) as Record<string, unknown>;

  if (body.action === "archive" || body.action === "restore") {
    await archiveThread(thread.id, body.action === "archive");
    return NextResponse.json({ ok: true });
  }

  const title = str(body.title, 120);
  if (!title) return NextResponse.json({ error: "REQUIRED" }, { status: 400 });

  await updateThread(thread.id, {
    title,
    kind: body.kind,
    companyId: body.companyId == null ? null : parseId(body.companyId),
    summary: str(body.summary, 300),
  });

  return NextResponse.json({ ok: true });
}
