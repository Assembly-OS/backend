import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { assignableUsers } from "@/lib/queries";
import {
  decideProposal,
  mayDecide,
  proposalById,
  type ProposalEdits,
} from "@/lib/agents/orchestrator";
import { id as parseId, oneOf, str } from "@/lib/validate";

/**
 * The review gate: the head of the department the work lands in decides what a
 * document produced — and corrects it first if the model read it wrong.
 *
 * Authorisation is the reviewer, not the submitter. A director uploading an
 * order for four departments is not the person who knows whether the third
 * department's deadline is achievable; the head of that department is, and
 * that is who the proposal is routed to. Where a department has no head the
 * submitter decides, because someone must.
 *
 * Edits are re-validated here rather than trusted: a reviewer may retarget an
 * assignment, but only to somebody they could have assigned to themselves.
 */
const PRIORITIES = ["PAST", "ORTA", "YUQORI", "KRITIK"] as const;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const proposalId = parseId((await params).id);
  if (!proposalId)
    return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const proposal = proposalById(proposalId);
  if (!proposal)
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  // Not "forbidden" — a person is told nothing about a proposal that is not
  // theirs to decide, including whether it exists.
  if (!mayDecide(proposal, user.id))
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const body = (await request.json()) as {
    decision?: unknown;
    edits?: Record<string, unknown>;
  };
  const decision = oneOf(
    body.decision,
    ["approve", "reject"] as const,
    "reject",
  );

  let edits: ProposalEdits | undefined;
  if (decision === "approve" && body.edits) {
    const raw = body.edits;
    edits = {};

    const title = str(raw.title, 200);
    if (title) edits.title = title;

    const description = str(raw.description, 4000);
    if (description !== null) edits.description = description;

    if (raw.priority !== undefined) {
      edits.priority = oneOf(raw.priority, PRIORITIES, "ORTA");
    }

    if (raw.deadline !== undefined) {
      const deadline = str(raw.deadline, 10);
      edits.deadline =
        deadline && /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : null;
    }

    if (raw.toUserId !== undefined) {
      const target = Number(raw.toUserId);
      // Re-checked against *this reviewer's* assignment graph. The draft's
      // original owner passed the same check when it was filed; a reviewer
      // retargeting it must clear it on their own authority.
      if (!assignableUsers(user).some((person) => person.id === target)) {
        return NextResponse.json({ error: "NOT_ASSIGNABLE" }, { status: 400 });
      }
      edits.toUserId = target;
    }
  }

  const outcome = decideProposal(proposalId, decision, user.login, edits);
  if (!outcome.ok)
    return NextResponse.json({ error: outcome.error }, { status: 400 });

  return NextResponse.json({ ok: true, result: outcome.result });
}
