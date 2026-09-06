import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { projectById, searchEntries, threadById } from "@/lib/project-threads";
import { id as parseId, str } from "@/lib/validate";

/**
 * Literal search across a project, or inside one of its chats.
 *
 * Deliberately separate from `ask`: this one is instant, free and predictable,
 * and it is what somebody wants when they remember a word rather than a
 * question. The two fail in opposite directions, so the interface offers both.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const projectId = parseId((await params).id);
  const project = projectId ? await projectById(projectId) : undefined;
  if (!project) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const url = new URL(request.url);
  const query = str(url.searchParams.get("q"), 200);
  if (!query) return NextResponse.json([]);

  const threadId = parseId(url.searchParams.get("threadId"));
  if (threadId) {
    const thread = await threadById(threadId);
    if (!thread || thread.project_id !== project.id)
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  return NextResponse.json(
    await searchEntries(
      { projectId: project.id, threadId: threadId ?? undefined },
      query,
    ),
  );
}
