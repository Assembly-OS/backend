import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canWrite, crmRole } from "@/lib/crm-access";
import { touchCompany } from "@/lib/crm";
import { setMeetingLinks } from "@/lib/meetings";
import { get, now, tx } from "@/lib/pg";
import { id as parseId, str } from "@/lib/validate";
import { raiseNextStep, readMeetingInput } from "../input";

/**
 * Editing a meeting after the fact.
 *
 * There was no way to do this at all: a meeting could be filed and never
 * corrected, so a wrong date or a missing "what was agreed" stayed wrong for
 * good. The TZ's intake flow depends on it — the AI fills the fields from a
 * transcript as a suggestion, and a person reviews and completes them.
 *
 * The person who filed it, the person answering for its next step, and the
 * chairman and his assistant may edit it. Anyone else who may write in the
 * CRM can read it but not rewrite somebody else's account of a meeting they
 * were not responsible for.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canWrite(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const meetingId = parseId((await params).id);
  if (!meetingId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const meeting = await get<{
    owner_id: number;
    responsible_id: number | null;
  }>("SELECT owner_id, responsible_id FROM meetings WHERE id = ?", meetingId);
  if (!meeting) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const mayEdit =
    meeting.owner_id === user.id ||
    meeting.responsible_id === user.id ||
    crmRole(user) === "admin";
  if (!mayEdit)
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const body = (await request.json()) as Record<string, unknown>;
  const read = await readMeetingInput(body, user, meeting.responsible_id);
  if (!read.ok) return NextResponse.json({ error: read.error }, { status: 400 });
  const input = read.input;

  // The transcript is only rewritten when the form sent one: an edit of the
  // facts must not blank a recording's text because the field was not shown.
  const transcript =
    typeof body.transcript === "string" ? (str(body.transcript, 200_000) ?? "") : null;

  await tx(async (q) => {
    await q.run(
      `UPDATE meetings
          SET title = ?, company_id = ?, held_at = ?, place = ?, participants = ?,
              responsible_id = ?, description = ?, agreed = ?, open_issues = ?,
              next_steps = ?, legal_status = ?, uyushma_id = ?,
              transcript = COALESCE(?, transcript), updated_at = ?
        WHERE id = ?`,
      input.title,
      input.company_id,
      input.held_at,
      input.place,
      input.participants,
      input.responsible_id,
      input.description,
      input.agreed,
      input.open_issues,
      input.next_steps,
      input.legal_status,
      input.uyushma_id,
      transcript,
      now(),
      meetingId,
    );
    await setMeetingLinks(q, meetingId, input.project_ids, input.staff_ids);
  });

  if (input.company_id)
    await touchCompany(input.company_id, input.held_at ?? now().slice(0, 10));

  const task = await raiseNextStep(meetingId, input, user);
  return NextResponse.json({ ok: true, id: meetingId, task });
}
