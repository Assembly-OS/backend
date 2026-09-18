import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canDelete, canWrite } from "@/lib/crm-access";
import { COMPANY_STATUSES, companyById, updateCompany } from "@/lib/crm";
import { actingAs } from "@/lib/archive";
import { get, tx } from "@/lib/pg";
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
  if (!companyId || !(await companyById(companyId)))
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

  await updateCompany(companyId, patch as { name: string });
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
  if (!(await companyById(companyId)))
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  // A company with a history is archived, not deleted — the rule staff
  // accounts already follow (HAS_HISTORY). Deleting used to unlink its
  // meetings and erase its agreements, so "when did we meet Parsons and what
  // did we agree" — the question the rebuild TZ is built around — lost its
  // answer to one confirm dialog. The status list has ARCHIVED for exactly
  // this. Deleting stays for the record that should never have existed: a
  // duplicate or a typo, with nothing hanging off it.
  const history = await get<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM meetings WHERE company_id = ?)
          + (SELECT COUNT(*) FROM agreements WHERE company_id = ?)
          + (SELECT COUNT(*) FROM project_threads WHERE company_id = ?)
          + (SELECT COUNT(*) FROM partner_notes WHERE partner_id = ?) AS n`,
    companyId,
    companyId,
    companyId,
    companyId,
  );
  if (Number(history?.n ?? 0) > 0)
    return NextResponse.json({ error: "HAS_HISTORY" }, { status: 409 });

  // One transaction: this used to be five separate statements, and a failure
  // part-way left a company that still existed with its links already cut.
  await tx(async (q) => {
    await actingAs(q, user.id);

    // Ideas that name this company as the other half of a match. With no
    // meetings behind it there are none of its own, but it may still be
    // somebody else's suggested partner. No ON DELETE rule on either column.
    await q.run(
      "DELETE FROM partner_ideas WHERE partner_id = ? OR match_id = ?",
      companyId,
      companyId,
    );

    // A bell that opens a page which no longer exists is worse than no bell.
    await q.run(
      "DELETE FROM notifications WHERE href = ?",
      `/companies/${companyId}`,
    );

    // Contacts cascade, and are archived with it by the database.
    await q.run("DELETE FROM partners WHERE id = ?", companyId);
  });
  return NextResponse.json({ ok: true });
}
