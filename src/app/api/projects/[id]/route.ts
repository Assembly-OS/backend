import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canManageProjects } from "@/lib/project-access";
import { projectById, updateProject } from "@/lib/project-threads";
import { PROJECT_PRIORITIES, PROJECT_STATUSES } from "@/lib/projects";
import { id as parseId, oneOf, str } from "@/lib/validate";

function isoDay(value: unknown): string | null {
  const day = str(value, 10);
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

export async function PATCH(
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
  const name = str(body.name, 120);
  if (!name) return NextResponse.json({ error: "REQUIRED" }, { status: 400 });

  await updateProject(project.id, {
    name,
    description: str(body.description, 2000),
    status: oneOf(body.status, PROJECT_STATUSES, "FAOL"),
    priority: oneOf(body.priority, PROJECT_PRIORITIES, "ORTA"),
    stage: str(body.stage, 160),
    deadline: isoDay(body.deadline),
    startedAt: isoDay(body.startedAt),
    ownerId: body.ownerId == null ? null : parseId(body.ownerId),
  });

  return NextResponse.json({ ok: true });
}
