import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canManageProjects } from "@/lib/project-access";
import { createThread, projectById, threadsOf } from "@/lib/project-threads";
import { id as parseId, str } from "@/lib/validate";

/** The threads of one project — the sidebar, as data. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const projectId = parseId((await params).id);
  if (!projectId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const archived = new URL(request.url).searchParams.get("archived") === "1";
  return NextResponse.json(await threadsOf(projectId, archived));
}

/**
 * Opens a thread. No ceremony and no limit: a programme touching eleven
 * ministries needs eleven threads, and the twelfth must cost one field.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canManageProjects(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const projectId = parseId((await params).id);
  const project = projectId ? await projectById(projectId) : undefined;
  if (!project)
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const body = (await request.json()) as Record<string, unknown>;
  const title = str(body.title, 120);
  if (!title) return NextResponse.json({ error: "REQUIRED" }, { status: 400 });

  const id = await createThread(project.id, user.id, {
    title,
    kind: body.kind,
    companyId: body.companyId == null ? null : parseId(body.companyId),
    summary: str(body.summary, 300),
  });

  return NextResponse.json({ ok: true, id });
}
