import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canManageProjects } from "@/lib/project-access";
import { readStages, saveStages } from "@/lib/project-stages";
import { today } from "@/lib/crm";
import { projectRights } from "@/lib/project-visibility";
import { id as parseId } from "@/lib/validate";

/**
 * Saves a project's work schedule, block 1.4 of the rebuild TZ.
 *
 * Kept by the people doing the work: TZ 4.2's "stage status" row — the
 * chairman, department, cluster and project heads, the outside project lead
 * on his own project — and this project's own leader and deputy — the TZ's
 * picture is the project leader logging "finding the building, a week" as it
 * happens, and a deputy on the staff is usually the one who does. Answering a
 * request for help is the Assembly's side of it, so only its managers may
 * change a request's status; anybody who may edit may ask.
 *
 * A refusal names the line it is about (`row`), so the editor can take the
 * person straight to it.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const projectId = parseId((await params).id);
  const project = projectId ? await projectRights(user, projectId) : null;
  if (!project) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (!project.enterStages)
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const manager = canManageProjects(user) && project.internal;

  const read = readStages((await request.json()) as Record<string, unknown>, today());
  if (!read.ok)
    return NextResponse.json({ error: read.error, row: read.row }, { status: 400 });

  await saveStages(project.id, read.rows, user, manager);
  return NextResponse.json({ ok: true });
}
