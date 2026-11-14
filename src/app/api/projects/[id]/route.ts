import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { projectRights } from "@/lib/project-visibility";
import { updatePassport } from "@/lib/project-threads";
import { readPassport } from "@/lib/projects";
import { id as parseId, str } from "@/lib/validate";
import { remember } from "@/lib/knowledge/sources";
import { get } from "@/lib/pg";
import { recordDecision } from "@/lib/project-decisions";
import { isOutcome } from "@/lib/signal-rules";
import type { Phase } from "@/lib/project-passport";

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

  const body = (await request.json()) as Record<string, unknown>;
  const read = await readPassport(body);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: 400 });

  // TZ 8.3: the phase moves only through a decision point. A passport that
  // arrives with a different phase and no decision is refused, so the form
  // asks for the outcome and the note; with them, the phase is written by
  // the decision and the rest of the passport by the save.
  const current = await get<{ phase: Phase | null }>("SELECT phase FROM loyihalar WHERE id = ?", project.id);
  const moving = (read.input.phase ?? null) !== (current?.phase ?? null);
  if (moving && !isOutcome(body.decision_outcome))
    return NextResponse.json({ error: "DECISION_REQUIRED" }, { status: 409 });

  await updatePassport(project.id, moving ? { ...read.input, phase: current?.phase ?? null } : read.input);
  if (moving && isOutcome(body.decision_outcome)) {
    await recordDecision(
      project.id,
      {
        outcome: body.decision_outcome,
        note: str(body.decision_note, 2000),
        phaseTo: (read.input.phase as Phase | null) ?? null,
        nextDecisionOn: read.input.next_decision_on,
      },
      user.id,
    );
  }
  void remember("project", project.id);
  return NextResponse.json({ ok: true });
}
