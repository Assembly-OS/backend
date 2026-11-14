import { get, now, tx } from "../pg";
import { advanceStage, createAgreement, createCompany, moveStage } from "../crm";
import { isStage } from "../crm-stages";
import { PHASES, type Phase } from "../project-passport";
import { recordDecision } from "../project-decisions";
import { LIFE_CYCLE } from "../signal-rules";
import { remember } from "../knowledge/sources";

/**
 * What an approved record proposal does (TZ 7.2). Each kind reaches the
 * base through the same library the forms use, so a record the AI drafted
 * and a record a person typed are indistinguishable afterwards — except
 * for the proposal row that says where it came from.
 */

export type RecordPayload =
  | {
      kind: "kelishuv";
      title: string;
      agreementKind: string | null;
      content: string | null;
      party_ids: number[];
      parties: string[];
      amount: number | null;
      currency: string | null;
      signed_on: string | null;
      valid_until: string | null;
      loyiha_id: number | null;
      meeting_id: number | null;
      obligations: { description: string; owner_user_id: number | null; deadline: string | null }[];
    }
  | {
      kind: "company";
      name: string;
      industry: string | null;
      description: string | null;
      head_name: string | null;
      head_position: string | null;
      country: string | null;
      city: string | null;
      website: string | null;
    }
  | { kind: "stage"; company_id: number; stage: string; rationale: string | null }
  | { kind: "phase"; project_id: number; phase: string; rationale: string | null };

async function userIdOf(login: string): Promise<number | null> {
  const row = await get<{ id: number }>("SELECT id FROM users WHERE login = ? AND is_active = 1", login);
  return row?.id ?? null;
}

/** Runs one approved record; returns the line the proposal keeps as its result. */
export async function executeRecord(
  payload: RecordPayload,
  decidedBy: string,
  ownerId: number | null,
): Promise<string> {
  const actor = (await userIdOf(decidedBy)) ?? ownerId;

  if (payload.kind === "company") {
    const id = await createCompany({
      name: payload.name.slice(0, 200),
      industry: payload.industry,
      description: payload.description,
      head_name: payload.head_name,
      head_position: payload.head_position,
      country: payload.country,
      city: payload.city,
      website: payload.website,
      status: "POTENTIAL",
      owner_user_id: actor,
    });
    return `kompaniya yaratildi: #${id}`;
  }

  if (payload.kind === "stage") {
    if (!isStage(payload.stage)) throw new Error("Noma'lum bosqich");
    const moved = await moveStage(payload.company_id, payload.stage, actor, { reason: "manual", note: payload.rationale });
    return moved ? `bosqich o'zgartirildi: ${payload.stage}` : "bosqich allaqachon shu";
  }

  if (payload.kind === "phase") {
    if (!actor) throw new Error("Qaror uchun shaxs kerak");
    if (!PHASES.includes(payload.phase as Phase)) throw new Error("Noma'lum faza");
    const current = await get<{ phase: Phase | null }>("SELECT phase FROM loyihalar WHERE id = ?", payload.project_id);
    if (!current) throw new Error("Loyiha topilmadi");
    // The approver is the person deciding: forwards is "continue", backwards
    // or sideways "rework", a freeze "stop" — written as a decision point.
    const to = payload.phase as Phase;
    const outcome =
      to === "FROZEN"
        ? "STOP"
        : current.phase && LIFE_CYCLE.indexOf(to) > LIFE_CYCLE.indexOf(current.phase)
          ? "CONTINUE"
          : current.phase
            ? "REWORK"
            : "CONTINUE";
    const result = await recordDecision(payload.project_id, { outcome, phaseTo: to, note: payload.rationale }, actor);
    return `loyiha fazasi: ${result.phase} (${outcome})`;
  }

  // An agreement: the card, its parties, its obligations, the path moves.
  const status = payload.signed_on ? "OPEN" : "DRAFT";
  const id = await tx(async (q) => {
    const newId = await q.insert(
      `INSERT INTO kelishuvlar
         (title, kind, content, loyiha_id, meeting_id, amount, currency,
          signed_on, valid_until, responsible_id, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      payload.title.slice(0, 200),
      payload.agreementKind,
      payload.content,
      payload.loyiha_id,
      payload.meeting_id,
      payload.amount,
      payload.currency,
      payload.signed_on,
      payload.valid_until,
      actor,
      status,
      actor,
      now(),
      now(),
    );
    for (const partyId of payload.party_ids)
      await q.run("INSERT INTO kelishuv_parties (kelishuv_id, company_id) VALUES (?, ?) ON CONFLICT DO NOTHING", newId, partyId);
    return newId;
  });
  for (const obligation of payload.obligations)
    await createAgreement({
      company_id: payload.party_ids[0] ?? null,
      meeting_id: payload.meeting_id,
      kelishuv_id: id,
      description: obligation.description.slice(0, 1000),
      owner_user_id: obligation.owner_user_id ?? actor,
      deadline: obligation.deadline,
      source: "AI",
      created_by: actor,
    });
  if (payload.signed_on)
    for (const partyId of payload.party_ids)
      await advanceStage(partyId, payload.agreementKind === "CONTRACT" ? "contract" : "kelishuv", actor, payload.title);
  void remember("kelishuv", id);
  return `kelishuv yaratildi: K-${id}${payload.parties.length && !payload.party_ids.length ? " (tomonlar bazada topilmadi)" : ""}`;
}
