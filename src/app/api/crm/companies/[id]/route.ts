import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canDelete, canWrite } from "@/lib/crm-access";
import { COMPANY_STATUSES, companyById, updateCompany } from "@/lib/crm";
import { run } from "@/lib/db";
import { id as parseId, oneOf, str } from "@/lib/validate";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canWrite(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const companyId = parseId((await params).id);
  if (!companyId || !companyById(companyId))
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const body = (await request.json()) as Record<string, unknown>;
  const patch: Record<string, string | number | null> = {};
  // Only fields actually present are touched, so a form that edits one thing
  // cannot blank the twenty it did not show.
  for (const [key, max] of [
    ["name", 160], ["description", 2000], ["industry", 120], ["direction", 200],
    ["services", 2000], ["country", 80], ["city", 80], ["address", 300],
    ["website", 200], ["email", 160], ["phone", 60], ["head_name", 160],
    ["head_position", 120], ["started_at", 10], ["next_contact_at", 10],
    ["notes", 4000],
  ] as const) {
    if (key in body) patch[key] = str(body[key], max);
  }
  if ("status" in body)
    patch.status = oneOf(body.status, COMPANY_STATUSES, "POTENTIAL");
  if ("owner_user_id" in body) patch.owner_user_id = parseId(body.owner_user_id);

  updateCompany(companyId, patch as { name: string });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canDelete(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const companyId = parseId((await params).id);
  if (!companyId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });
  if (!companyById(companyId))
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  // Meetings outlive the company record — they are the history, and deleting
  // a directory entry must not erase what was said. They are unlinked instead.
  run("UPDATE meetings SET company_id = NULL WHERE company_id = ?", companyId);

  // What the meeting analyses concluded *about this company*, and what it
  // suggested proposing to them. Unlike a meeting, none of it means anything
  // once the company is gone. These two carry no ON DELETE rule, so without
  // this the delete failed on a foreign-key constraint for any company that
  // had ever been through an analysis — which is most of them.
  run("DELETE FROM partner_notes WHERE partner_id = ?", companyId);
  run(
    "DELETE FROM partner_ideas WHERE partner_id = ? OR match_id = ?",
    companyId,
    companyId,
  );

  // A bell that opens a page which no longer exists is worse than no bell.
  run("DELETE FROM notifications WHERE href = ?", `/companies/${companyId}`);

  // Contacts and agreements cascade; the reminders hanging off those
  // agreements cascade in turn.
  run("DELETE FROM partners WHERE id = ?", companyId);
  return NextResponse.json({ ok: true });
}
