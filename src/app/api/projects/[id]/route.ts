import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canManageProjects } from "@/lib/project-access";
import { projectById, updatePassport } from "@/lib/project-threads";
import { readPassport } from "@/lib/projects";
import { id as parseId } from "@/lib/validate";

/**
 * Saves a project's passport, block 1.3 of the rebuild TZ.
 *
 * This route existed and nothing called it: the project card had no way to
 * edit a project at all, which is the TZ's finding — the fields were in the
 * database and nowhere to fill them. It now takes the whole passport. Who may
 * save it is unchanged: the managers who may open and restructure projects.
 */
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

  const read = await readPassport((await request.json()) as Record<string, unknown>);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: 400 });

  await updatePassport(project.id, read.input);
  return NextResponse.json({ ok: true });
}
