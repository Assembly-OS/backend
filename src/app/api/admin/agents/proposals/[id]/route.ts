import { NextResponse } from "next/server";
import { hasAdminSession, ADMIN_LOGIN } from "@/lib/admin-auth";
import { decideProposal } from "@/lib/agents/orchestrator";
import { id as parseId, oneOf } from "@/lib/validate";

/**
 * HUMAN APPROVAL — the gate between a proposal and any effect it may have.
 * The decision is stamped with who made it, so the audit log answers "who let
 * this happen" and not merely "what happened".
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await hasAdminSession()))
    return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const proposalId = parseId((await params).id);
  if (!proposalId)
    return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const body = (await request.json()) as { decision?: unknown };
  const decision = oneOf(body.decision, ["approve", "reject"] as const, "reject");

  const outcome = decideProposal(proposalId, decision, ADMIN_LOGIN);
  if (!outcome.ok)
    return NextResponse.json(
      { error: outcome.error },
      { status: outcome.error === "NOT_FOUND" ? 404 : 400 },
    );

  return NextResponse.json({ ok: true, result: outcome.result });
}
