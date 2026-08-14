import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canWrite } from "@/lib/crm-access";
import { deleteContact } from "@/lib/crm";
import { id as parseId } from "@/lib/validate";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canWrite(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const contactId = parseId((await params).id);
  if (!contactId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });
  deleteContact(contactId);
  return NextResponse.json({ ok: true });
}
