import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canManageProjects } from "@/lib/project-access";
import { attach, projectRights } from "@/lib/project-visibility";
import {
  addThreadMember,
  removeThreadMember,
  threadById,
  threadMembers,
} from "@/lib/project-threads";
import { id as parseId } from "@/lib/validate";

async function resolve(params: Promise<{ id: string }>) {
  const threadId = parseId((await params).id);
  return threadId ? await threadById(threadId) : undefined;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const thread = await resolve(params);
  // A thread of a project this person cannot see does not exist for them.
  const rights = thread ? await projectRights(user, thread.project_id) : null;
  if (!thread || !rights?.internal)
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  return NextResponse.json(await threadMembers(thread.id));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canManageProjects(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const thread = await resolve(params);
  // A thread of a project this person cannot see does not exist for them.
  const rights = thread ? await projectRights(user, thread.project_id) : null;
  if (!thread || !rights?.internal)
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const body = (await request.json()) as Record<string, unknown>;
  const userId = parseId(body.userId);
  if (!userId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  await addThreadMember(thread.id, userId);
  // Following a thread is working on the project: without this, the new
  // member would be notified about a project they cannot open.
  await attach(thread.project_id, userId, user.id);
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canManageProjects(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const thread = await resolve(params);
  // A thread of a project this person cannot see does not exist for them.
  const rights = thread ? await projectRights(user, thread.project_id) : null;
  if (!thread || !rights?.internal)
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const userId = parseId(new URL(request.url).searchParams.get("userId"));
  if (!userId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  await removeThreadMember(thread.id, userId);
  return NextResponse.json({ ok: true });
}
