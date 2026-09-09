import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canManageProjects } from "@/lib/project-access";
import {
  archiveThread,
  deleteThread,
  threadById,
  updateThread,
} from "@/lib/project-threads";
import { id as parseId, str } from "@/lib/validate";

/**
 * Renaming a thread, moving it onto a company, rewriting the line that says
 * where it stands — or archiving it.
 *
 * Archiving remains the ordinary way out of the sidebar: a finished
 * counterpart is precisely the thread somebody reads two years later to find
 * out what was actually agreed, and archiving keeps every word of it.
 * DELETE below is for the other case — the chat that should never have
 * existed.
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

/**
 * Deletes the thread and everything written in it.
 *
 * Open to the same people who may create one, and that symmetry is the point.
 * Opening a chat under the wrong project is an ordinary slip — the entries go
 * in, and only afterwards does somebody notice the project is wrong. If the
 * person who made that mistake cannot undo it without finding the chairman,
 * what they do instead is leave it there, and a register nobody can correct
 * stops being trusted.
 *
 * Two things keep this from being the dangerous button it looks like: the
 * chat is deleted from its own page, with its journal on screen above the
 * control, and what the entries produced — agreements, tasks — survives.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canManageProjects(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const threadId = parseId((await params).id);
  if (!threadId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });
  const thread = await threadById(threadId);
  if (!thread) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  await deleteThread(thread.id);
  return NextResponse.json({ ok: true });
}
