import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canManageProjects } from "@/lib/project-access";
import { readStages, saveStages } from "@/lib/project-stages";
import { today } from "@/lib/crm";
import { get } from "@/lib/pg";
import { id as parseId } from "@/lib/validate";

/**
 * Saves a project's work schedule, block 1.4 of the rebuild TZ.
 *
 * Kept by the people doing the work: the managers who may restructure any
 * project, and this project's own leader and deputy — the TZ's picture is the
 * project leader logging "finding the building, a week" as it happens, and a
 * deputy on the staff is usually the one who does. Answering a request for
 * help is the Assembly's side of it, so only the managers may change a
 * request's status; anybody who may edit may ask.
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
  const project = projectId
    ? await get<{ id: number; owner_id: number | null; deputy_id: number | null }>(
        "SELECT id, owner_id, deputy_id FROM loyihalar WHERE id = ?",
        projectId,
      )
    : undefined;
  if (!project) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const manager = canManageProjects(user);
  const mayEdit = manager || project.owner_id === user.id || project.deputy_id === user.id;
  if (!mayEdit) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const read = readStages((await request.json()) as Record<string, unknown>, today());
  if (!read.ok)
    return NextResponse.json({ error: read.error, row: read.row }, { status: 400 });

  await saveStages(project.id, read.rows, user, manager);
  return NextResponse.json({ ok: true });
}
