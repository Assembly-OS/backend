import { NextResponse } from "next/server";
import { currentUser, currentLocale } from "@/lib/session";
import { askMemory } from "@/lib/agents/memory";
import { projectById, threadById } from "@/lib/project-threads";
import { id as parseId, str } from "@/lib/validate";

/**
 * Asks the project's memory a question.
 *
 * `threadId` narrows the scope to one chat and is the difference between "what
 * did we agree with UNIDO" and "what is happening with Smart City" — the same
 * endpoint, because the only thing that changes is which records are read.
 *
 * A thread that belongs to a different project is rejected rather than
 * quietly ignored: silently widening the scope would answer from records the
 * asker did not mean to include.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const projectId = parseId((await params).id);
  const project = projectId ? await projectById(projectId) : undefined;
  if (!project) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const body = (await request.json()) as Record<string, unknown>;
  const question = str(body.question, 500);
  if (!question) return NextResponse.json({ error: "EMPTY" }, { status: 400 });

  const threadId = body.threadId == null ? undefined : parseId(body.threadId);
  if (threadId) {
    const thread = await threadById(threadId);
    if (!thread || thread.project_id !== project.id)
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const locale = await currentLocale(user);
  const outcome = await askMemory(
    { projectId: project.id, threadId: threadId ?? undefined },
    question,
    locale,
  );

  if (!outcome.ok)
    return NextResponse.json(
      { error: outcome.reason },
      // NO_KEY and EMPTY are not failures of this request — the first is a
      // configuration the asker cannot fix, the second means nothing has been
      // written yet. Both read better as an answer than as a red error.
      { status: outcome.reason === "ERROR" ? 502 : 200 },
    );

  return NextResponse.json(outcome.reply);
}
