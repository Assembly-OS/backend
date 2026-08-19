import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canSettle } from "@/lib/crm-access";
import { AGREEMENT_STATUSES, agreementById, setAgreementStatus } from "@/lib/crm";
import { id as parseId, oneOf } from "@/lib/validate";

/** Move one agreement along its lifecycle. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const agreementId = parseId((await params).id);
  const agreement = agreementId ? await agreementById(agreementId) : undefined;
  if (!agreement)
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (!canSettle(user, agreement.owner_user_id))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const body = (await request.json()) as { status?: unknown };
  await setAgreementStatus(
    agreement.id,
    oneOf(body.status, AGREEMENT_STATUSES, "IN_PROGRESS"),
  );
  return NextResponse.json({ ok: true });
}
