import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canWrite, crmRole } from "@/lib/crm-access";
import { setParties } from "@/lib/kelishuvlar";
import { get, now, tx } from "@/lib/pg";
import { id as parseId } from "@/lib/validate";
import { readKelishuvInput, syncObligations } from "../input";

/**
 * Correcting an agreement, its parties and its obligations.
 *
 * Whoever recorded it, whoever answers for it, and the chairman's side — the
 * same three who may edit a meeting, for the same reason: the record is only
 * worth something if a colleague cannot quietly rewrite it.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canWrite(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const current = await get<{ created_by: number | null; responsible_id: number | null }>(
    "SELECT created_by, responsible_id FROM kelishuvlar WHERE id = ?",
    id,
  );
  if (!current) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  const mayEdit =
    current.created_by === user.id ||
    current.responsible_id === user.id ||
    crmRole(user) === "admin";
  if (!mayEdit) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const read = await readKelishuvInput((await request.json()) as Record<string, unknown>);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: 400 });
  const input = read.input;

  await tx(async (q) => {
    await q.run(
      `UPDATE kelishuvlar
          SET title = ?, kind = ?, content = ?, loyiha_id = ?, meeting_id = ?,
              amount = ?, currency = ?, signed_on = ?, valid_until = ?,
              responsible_id = ?, status = ?, updated_at = ?
        WHERE id = ?`,
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
      now(),
      id,
    );
    await setParties(q, id, input.party_ids);
  });

  await syncObligations(id, input, user);
  return NextResponse.json({ ok: true, id });
}
