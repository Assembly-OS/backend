import { all, get, run } from "@/lib/pg";
import { createAssignment } from "@/lib/assignments";
import { companyById } from "@/lib/crm";
import { LEGAL_STATUSES, meetingCode, type LegalStatus } from "@/lib/meetings";
import { assignableUsers } from "@/lib/queries";
import { receivesTasks, type User } from "@/lib/types";
import { id as parseId, str } from "@/lib/validate";

/** A meeting body, checked and normalised, ready to write. */
export interface MeetingInput {
  title: string;
  company_id: number | null;
  held_at: string | null;
  place: string | null;
  participants: string | null;
  responsible_id: number | null;
  description: string | null;
  agreed: string | null;
  open_issues: string | null;
  next_steps: string | null;
  legal_status: LegalStatus | null;
  uyushma_id: number | null;
  project_ids: number[];
  staff_ids: number[];
}

/** Integer ids out of whatever the client sent, deduplicated, at most `max`. */
function idList(value: unknown, max: number): number[] {
  if (!Array.isArray(value)) return [];
  const ids = value.map(parseId).filter((n): n is number => n !== null);
  return [...new Set(ids)].slice(0, max);
}

/** Which of `ids` exist in `table` — anything else was invented by the client. */
async function existing(
  table: "loyihalar" | "users",
  ids: number[],
  extra = "",
): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await all<{ id: number }>(
    `SELECT id FROM ${table} WHERE id IN (${ids.map(() => "?").join(",")}) ${extra}`,
    ...ids,
  );
  return rows.map((row) => row.id);
}

/**
 * Checks a meeting body the same way for a new meeting and an edit.
 *
 * One function for both, because the two routes each growing their own rules
 * is how the dashboard came to show four different totals.
 *
 * Only the title is refused when missing. Everything else the TZ calls
 * required is judged by `missingFields` and shown as an incomplete record: a
 * meeting typed in a hurry, or filled by the AI from a transcript and not yet
 * reviewed, is still a meeting.
 *
 * The responsible person is checked against who the author may assign to.
 * It used to be a label and could name anyone; it now becomes a real
 * assignment when the meeting has a next step, and a meeting form must not be
 * a way to hand work to somebody the author could not otherwise reach.
 */
export async function readMeetingInput(
  body: Record<string, unknown>,
  user: User,
  /** On an edit, the responsible person already on the record. */
  current?: number | null,
): Promise<{ ok: true; input: MeetingInput } | { ok: false; error: string }> {
  const title = str(body.title, 160);
  if (!title) return { ok: false, error: "TITLE_REQUIRED" };

  const companyId = parseId(body.company_id);
  if (companyId && !(await companyById(companyId)))
    return { ok: false, error: "COMPANY_NOT_FOUND" };

  const uyushmaId = parseId(body.uyushma_id);
  if (
    uyushmaId &&
    !(await get("SELECT id FROM uyushmalar WHERE id = ?", uyushmaId))
  )
    return { ok: false, error: "UYUSHMA_NOT_FOUND" };

  // Left blank, the author answers for the next step — unless the author is
  // somebody who receives no work (the chairman), in which case it stays
  // blank and the record shows as incomplete until somebody is named.
  const picked = parseId(body.responsible_id);
  const responsible = picked ?? (receivesTasks(user.role) ? user.id : null);
  // A person already on the record is not re-judged on an edit: whoever
  // corrects a date on a colleague's meeting should not be refused for a
  // responsible they did not choose and may not themselves assign to.
  if (
    responsible !== null &&
    responsible !== current &&
    !(await assignableUsers(user)).some((person) => person.id === responsible)
  )
    return { ok: false, error: "RESPONSIBLE_FORBIDDEN" };

  const legal = str(body.legal_status, 20);
  if (legal && !LEGAL_STATUSES.includes(legal as LegalStatus))
    return { ok: false, error: "BAD_LEGAL_STATUS" };

  const heldAt = str(body.held_at, 10);

  return {
    ok: true,
    input: {
      title,
      company_id: companyId,
      held_at: heldAt && /^\d{4}-\d{2}-\d{2}$/.test(heldAt) ? heldAt : null,
      place: str(body.place, 200),
      participants: str(body.participants, 1000),
      responsible_id: responsible,
      description: str(body.description, 4000),
      agreed: str(body.agreed, 4000),
      open_issues: str(body.open_issues, 4000),
      next_steps: str(body.next_steps, 4000),
      legal_status: (legal as LegalStatus | null) ?? null,
      uyushma_id: uyushmaId,
      // Links to rows that do not exist are dropped rather than refused: a
      // project deleted while the form was open should not cost the meeting.
      project_ids: await existing("loyihalar", idList(body.project_ids, 20)),
      staff_ids: await existing(
        "users",
        idList(body.staff_ids, 40),
        "AND is_active = 1",
      ),
    },
  };
}

/**
 * Turns the meeting's next step into an assignment, once.
 *
 * The TZ: "Keyingi qadam va mas'ul — avtomatik topshiriqqa aylanadi". Once,
 * because the meeting keeps the id of the assignment it raised: an edit that
 * rewords the next step changes the record, not somebody's inbox a second
 * time. The first line becomes the assignment's title; the whole step and the
 * meeting it came from go in its description, so the person receiving it can
 * see why.
 *
 * A refusal from the assignment graph is returned, not thrown: the meeting is
 * already saved, and losing it over the follow-up would be the wrong way round.
 */
export async function raiseNextStep(
  meetingId: number,
  input: MeetingInput,
  author: User,
): Promise<{ code: string } | { error: string } | null> {
  if (!input.next_steps || input.responsible_id === null) return null;
  const current = await get<{ next_task_id: number | null }>(
    "SELECT next_task_id FROM meetings WHERE id = ?",
    meetingId,
  );
  if (current?.next_task_id) return null;

  const firstLine = input.next_steps.split("\n")[0].trim().slice(0, 160);
  const source = `${meetingCode(meetingId)} · ${input.title}${
    input.held_at ? ` · ${input.held_at}` : ""
  }`;
  try {
    const task = await createAssignment(
      author.id,
      {
        toUserId: input.responsible_id,
        title: firstLine,
        description: `${input.next_steps}\n\n${source}`,
      },
      `Uchrashuvdan: ${source}`,
    );
    await run("UPDATE meetings SET next_task_id = ? WHERE id = ?", task.id, meetingId);
    return { code: task.code };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "TASK_FAILED" };
  }
}
