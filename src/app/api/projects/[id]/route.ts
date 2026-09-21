import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { projectRights } from "@/lib/project-visibility";
import { updatePassport } from "@/lib/project-threads";
import { readPassport } from "@/lib/projects";
import { id as parseId } from "@/lib/validate";

/**
 * Saves a project's passport, block 1.3 of the rebuild TZ.
 *
 * This route existed and nothing called it: the project card had no way to
 * edit a project at all, which is the TZ's finding — the fields were in the
 * database and nowhere to fill them. It now takes the whole passport. Who may
 * save it is TZ 4.2's row: the chairman, department and cluster heads, and a
 * project lead on his own project.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const projectId = parseId((await params).id);
  const project = projectId ? await projectRights(user, projectId) : null;
  if (!project)
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (!project.editPassport)
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const read = await readPassport((await request.json()) as Record<string, unknown>);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: 400 });

  await updatePassport(project.id, read.input);
  return NextResponse.json({ ok: true });
}
