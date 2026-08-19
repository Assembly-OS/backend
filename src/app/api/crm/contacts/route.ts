import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canWrite } from "@/lib/crm-access";
import { companyById, createContact } from "@/lib/crm";
import { id as parseId, str } from "@/lib/validate";

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canWrite(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const body = (await request.json()) as Record<string, unknown>;
  const companyId = parseId(body.company_id);
  const firstName = str(body.first_name, 80);
  if (!companyId || !(await companyById(companyId)))
    return NextResponse.json({ error: "COMPANY_NOT_FOUND" }, { status: 400 });
  if (!firstName)
    return NextResponse.json({ error: "NAME_REQUIRED" }, { status: 400 });

  const id = await createContact({
    company_id: companyId,
    first_name: firstName,
    last_name: str(body.last_name, 80) ?? "",
    position: str(body.position, 120),
    phone: str(body.phone, 60),
    email: str(body.email, 160),
    telegram: str(body.telegram, 120),
    is_head: body.is_head === true,
    note: str(body.note, 1000),
  });
  return NextResponse.json({ ok: true, id });
}
