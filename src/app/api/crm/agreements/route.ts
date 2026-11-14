import { NextResponse } from "next/server";
import { projectRights } from "@/lib/project-visibility";
import { currentUser } from "@/lib/session";
import { canRead, canWrite } from "@/lib/crm-access";
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
  // The companies and agreements base is the staff's (TZ 4.3).
  if (!canRead(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
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
  // Filed under a project only if its author can see that project (TZ 4.2).
  const loyihaId = parseId(body.loyiha_id);
  if (loyihaId !== null && !(await projectRights(user, loyihaId)))
    return NextResponse.json({ error: "BAD_PROJECT" }, { status: 400 });
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
    // Set when the commitment was recorded inside a project thread, so it can
    // be found from the project as well as from the company.
    loyiha_id: loyihaId,
    thread_id: parseId(body.thread_id),
  });
  return NextResponse.json({ ok: true, id });
}
