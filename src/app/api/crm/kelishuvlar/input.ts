import { actingAs } from "@/lib/archive";
import { all, get, run, tx } from "@/lib/pg";
import { createAgreement, scheduleReminder } from "@/lib/crm";
import {
  CURRENCIES,
  KELISHUV_KINDS,
  KELISHUV_STATUSES,
  type KelishuvKind,
  type KelishuvStatus,
} from "@/lib/kelishuvlar";
import type { User } from "@/lib/types";
import { id as parseId, oneOf, str } from "@/lib/validate";

/** One obligation as the form sends it: a new line, or an edit of a kept one. */
export interface ObligationInput {
  id: number | null;
  description: string;
  owner_user_id: number | null;
  owner_name: string | null;
  deadline: string | null;
}

/** An agreement body, checked and normalised, ready to write. */
export interface KelishuvInput {
  title: string;
  kind: KelishuvKind | null;
  content: string | null;
  loyiha_id: number | null;
  meeting_id: number | null;
  amount: number | null;
  currency: string | null;
  signed_on: string | null;
  valid_until: string | null;
  responsible_id: number | null;
  status: KelishuvStatus;
  party_ids: number[];
  obligations: ObligationInput[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const date = (value: unknown) => {
  const text = str(value, 10);
  return text && DATE.test(text) ? text : null;
};

/** Which of `ids` exist in `table`; anything else was invented by the client. */
async function existing(
  table: "partners" | "users",
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
 * Checks an agreement body the same way for a new one and an edit.
 *
 * Only the title is refused when missing; everything else the TZ requires is
 * judged by `missingKelishuv` and shown. What is refused is what cannot be
 * true: a term that ends before it was signed, a negative sum, or a project,
 * meeting or person that does not exist.
 */
export async function readKelishuvInput(
  body: Record<string, unknown>,
): Promise<{ ok: true; input: KelishuvInput } | { ok: false; error: string }> {
  const title = str(body.title, 160);
  if (!title) return { ok: false, error: "TITLE_REQUIRED" };

  const loyihaId = parseId(body.loyiha_id);
  if (loyihaId && !(await get("SELECT id FROM loyihalar WHERE id = ?", loyihaId)))
    return { ok: false, error: "GONE" };

  const meetingId = parseId(body.meeting_id);
  if (meetingId && !(await get("SELECT id FROM meetings WHERE id = ?", meetingId)))
    return { ok: false, error: "GONE" };

  const responsible = parseId(body.responsible_id);
  if (
    responsible &&
    !(await get("SELECT id FROM users WHERE id = ? AND is_active = 1", responsible))
  )
    return { ok: false, error: "GONE" };

  const signedOn = date(body.signed_on);
  const validUntil = date(body.valid_until);
  if (signedOn && validUntil && validUntil < signedOn)
    return { ok: false, error: "BAD_TERM" };

  let amount: number | null = null;
  if (body.amount !== null && body.amount !== undefined && body.amount !== "") {
    const n = Number(body.amount);
    if (!Number.isFinite(n) || n < 0) return { ok: false, error: "BAD_AMOUNT" };
    amount = n;
  }

  const kind = str(body.kind, 20);
  if (kind && !KELISHUV_KINDS.includes(kind as KelishuvKind))
    return { ok: false, error: "BAD_KIND" };

  const partyIds = Array.isArray(body.party_ids)
    ? [...new Set(body.party_ids.map(parseId).filter((n): n is number => n !== null))].slice(0, 10)
    : [];

  const rawObligations = Array.isArray(body.obligations) ? body.obligations.slice(0, 30) : [];
  const owners = await existing(
    "users",
    rawObligations
      .map((raw) => parseId((raw as Record<string, unknown>).owner_user_id))
      .filter((n): n is number => n !== null),
    "AND is_active = 1",
  );
  const obligations: ObligationInput[] = [];
  for (const raw of rawObligations) {
    const item = raw as Record<string, unknown>;
    const description = str(item.description, 1000);
    // A blank line in the list is a line somebody added and did not fill,
    // not an obligation.
    if (!description) continue;
    const owner = parseId(item.owner_user_id);
    obligations.push({
      id: parseId(item.id),
      description,
      owner_user_id: owner && owners.includes(owner) ? owner : null,
      owner_name: str(item.owner_name, 160),
      deadline: date(item.deadline),
    });
  }

  return {
    ok: true,
    input: {
      title,
      kind: (kind as KelishuvKind | null) ?? null,
      content: str(body.content, 4000),
      loyiha_id: loyihaId,
      meeting_id: meetingId,
      amount,
      // A sum is never stored without the currency it is in.
      currency: amount === null ? null : oneOf(body.currency, CURRENCIES, "UZS"),
      signed_on: signedOn,
      valid_until: validUntil,
      responsible_id: responsible,
      status: oneOf(body.status, KELISHUV_STATUSES, "DRAFT"),
      party_ids: await existing("partners", partyIds),
      obligations,
    },
  };
}

/**
 * Makes the agreement's obligations say exactly what the form sent.
 *
 * A line with an id is an edit of an obligation already under this agreement;
 * a line without one is new and is created as a commitment in its own right —
 * notified, reminded, on the deadline board — through the same function every
 * other commitment goes through. An obligation left off the list is deleted,
 * and the database copies it into the archive as it goes.
 *
 * Status is not touched here. Settling an obligation — done, cancelled — is
 * done where it always was, by the person who owes it; rewording the
 * agreement must not quietly reopen or close anyone's commitment.
 *
 * When an edit changes who owes it or by when, its pending reminders are
 * rescheduled: otherwise the old owner would be reminded of somebody else's
 * deadline, on the old date.
 */
export async function syncObligations(
  kelishuvId: number,
  input: KelishuvInput,
  author: User,
): Promise<void> {
  const kept = await all<{
    id: number;
    owner_user_id: number | null;
    deadline: string | null;
  }>(
    "SELECT id, owner_user_id, deadline FROM agreements WHERE kelishuv_id = ?",
    kelishuvId,
  );
  const keptIds = new Set(kept.map((row) => row.id));
  const sent = new Set(
    input.obligations.map((row) => row.id).filter((id): id is number => id !== null),
  );

  const dropped = kept.filter((row) => !sent.has(row.id));
  if (dropped.length) {
    await tx(async (q) => {
      await actingAs(q, author.id);
      for (const row of dropped)
        await q.run("DELETE FROM agreements WHERE id = ?", row.id);
    });
  }

  for (const line of input.obligations) {
    if (line.id !== null && keptIds.has(line.id)) {
      const before = kept.find((row) => row.id === line.id)!;
      await run(
        `UPDATE agreements
            SET description = ?, owner_user_id = ?, owner_name = ?, deadline = ?,
                company_id = ?, loyiha_id = ?, meeting_id = ?
          WHERE id = ?`,
        line.description,
        line.owner_user_id,
        line.owner_name,
        line.deadline,
        input.party_ids[0] ?? null,
        input.loyiha_id,
        input.meeting_id,
        line.id,
      );
      if (
        before.owner_user_id !== line.owner_user_id ||
        before.deadline !== line.deadline
      ) {
        await run(
          "DELETE FROM reminders WHERE agreement_id = ? AND status = 'PENDING'",
          line.id,
        );
        if (line.owner_user_id && line.deadline)
          await scheduleReminder(line.id, line.owner_user_id, line.deadline, line.description);
      }
      continue;
    }
    // New, or an id that does not belong to this agreement — never adopt a
    // commitment from elsewhere by guessing at an id.
    await createAgreement({
      kelishuv_id: kelishuvId,
      company_id: input.party_ids[0] ?? null,
      loyiha_id: input.loyiha_id,
      meeting_id: input.meeting_id,
      description: line.description,
      owner_user_id: line.owner_user_id,
      owner_name: line.owner_name,
      deadline: line.deadline,
      created_by: author.id,
    });
  }
}
