import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canWrite } from "@/lib/crm-access";
import {
  AGREEMENT_STATUSES,
  PRIORITIES,
  agreementBoard,
  createAgreement,
} from "@/lib/crm";
import { id as parseId, oneOf, str } from "@/lib/validate";

export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  const mine = new URL(request.url).searchParams.get("mine") === "1";
  return NextResponse.json(await agreementBoard(mine ? user.id : undefined));
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canWrite(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const body = (await request.json()) as Record<string, unknown>;
  const description = str(body.description, 1000);
  if (!description)
    return NextResponse.json({ error: "DESCRIPTION_REQUIRED" }, { status: 400 });

  const deadline = str(body.deadline, 10);
  const id = await createAgreement({
    company_id: parseId(body.company_id),
    meeting_id: parseId(body.meeting_id),
    description,
    owner_user_id: parseId(body.owner_user_id),
    owner_name: str(body.owner_name, 160),
    // A malformed date is dropped rather than stored: a deadline nobody can
    // compare is worse than none at all.
    deadline: deadline && /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : null,
    status: oneOf(body.status, AGREEMENT_STATUSES, "NEW"),
    priority: oneOf(body.priority, PRIORITIES, "ORTA"),
    note: str(body.note, 1000),
    created_by: user.id,
  });
  return NextResponse.json({ ok: true, id });
}
