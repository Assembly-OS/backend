import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { projectRights } from "@/lib/project-visibility";
import { decisionsOf, markReviewed, recordDecision } from "@/lib/project-decisions";
import { PHASES, type Phase } from "@/lib/project-passport";
import { isOutcome } from "@/lib/signal-rules";
import { id as parseId, str } from "@/lib/validate";

type Params = { params: Promise<{ id: string }> };

/** The project's decisions, newest first (TZ 8.3). */
export async function GET(_request: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  const projectId = parseId((await params).id);
  const project = projectId ? await projectRights(user, projectId) : null;
  if (!project) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ decisions: await decisionsOf(project.id) });
}

/**
 * Takes a decision — continue, rework or stop — or records a review that
 * changed nothing (`review: true`). Whoever may edit the passport may decide:
 * the chairman, the cluster and department heads, the project's own lead.
 */
export async function POST(request: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  const projectId = parseId((await params).id);
  const project = projectId ? await projectRights(user, projectId) : null;
  if (!project) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (!project.editPassport) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (body.review === true) {
    return NextResponse.json({ ok: true, next_decision_on: await markReviewed(project.id) });
  }
  if (!isOutcome(body.outcome)) return NextResponse.json({ error: "BAD_OUTCOME" }, { status: 400 });
  const phaseTo = PHASES.includes(body.phase_to as Phase) ? (body.phase_to as Phase) : null;
  const next = str(body.next_decision_on, 10);
  const result = await recordDecision(
    project.id,
    {
      outcome: body.outcome,
      note: str(body.note, 2000),
      phaseTo,
      nextDecisionOn: next && /^\d{4}-\d{2}-\d{2}$/.test(next) ? next : null,
    },
    user.id,
  );
  return NextResponse.json({ ok: true, ...result });
}
