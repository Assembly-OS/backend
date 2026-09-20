import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canWrite } from "@/lib/crm-access";
import { setParties } from "@/lib/kelishuvlar";
import { now, tx } from "@/lib/pg";
import { readKelishuvInput, syncObligations } from "./input";

/**
 * Records an agreement: the document, its parties and its obligations.
 *
 * The agreement and its parties land in one transaction. The obligations are
 * created after it, each through the commitment path — notified to whoever
 * owes it and reminded before its date — which does its own writing; a
 * failure there leaves an agreement with fewer obligations than typed, shown
 * as incomplete, rather than no agreement at all.
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canWrite(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const read = await readKelishuvInput((await request.json()) as Record<string, unknown>);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: 400 });
  const input = read.input;

  const id = await tx(async (q) => {
    const newId = await q.insert(
      `INSERT INTO kelishuvlar
         (title, kind, content, loyiha_id, meeting_id, amount, currency,
          signed_on, valid_until, responsible_id, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      input.title,
      input.kind,
      input.content,
      input.loyiha_id,
      input.meeting_id,
      input.amount,
      input.currency,
      input.signed_on,
      input.valid_until,
      input.responsible_id,
      input.status,
      user.id,
      now(),
      now(),
    );
    await setParties(q, newId, input.party_ids);
    return newId;
  });

  await syncObligations(id, input, user);
  return NextResponse.json({ ok: true, id });
}
