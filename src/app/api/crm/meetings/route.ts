import { NextResponse } from "next/server";
import { get, now, run } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { canWrite } from "@/lib/crm-access";
import { companyById, createAgreement, touchCompany } from "@/lib/crm";
import { runMeetingIntake } from "@/lib/agents/intake-runner";
import { assignableUsers } from "@/lib/queries";
import { id as parseId, oneOf, str } from "@/lib/validate";

/**
 * A meeting typed in by hand, optionally with its transcript, optionally
 * analysed on the spot.
 *
 * The recorder route (`/api/ai/meeting`) exists for a meeting captured live.
 * This one is for the far commoner case: it already happened, somebody has the
 * notes, and they want them in the system attached to the right company.
 *
 * Analysis is opt-in rather than automatic. A three-line note about a phone
 * call does not need a model run, and charging one to every filed meeting is
 * how an AI feature becomes an AI bill.
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canWrite(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const body = (await request.json()) as Record<string, unknown>;

  const title = str(body.title, 160);
  if (!title) return NextResponse.json({ error: "TITLE_REQUIRED" }, { status: 400 });

  const companyId = parseId(body.company_id);
  if (companyId && !companyById(companyId))
    return NextResponse.json({ error: "COMPANY_NOT_FOUND" }, { status: 400 });

  const heldAt = str(body.held_at, 10);
  const lang = oneOf(body.lang, ["auto", "uz-UZ", "ru-RU", "en-US"] as const, "auto");
  const transcript = str(body.transcript, 200_000) ?? "";
  const responsible = parseId(body.responsible_id) ?? user.id;

  run(
    `INSERT INTO meetings
       (title, owner_id, company_id, held_at, place, participants, responsible_id,
        description, next_steps, transcript, lang, duration, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    title,
    user.id,
    companyId,
    heldAt && /^\d{4}-\d{2}-\d{2}$/.test(heldAt) ? heldAt : null,
    str(body.place, 200),
    str(body.participants, 1000),
    responsible,
    str(body.description, 4000),
    str(body.next_steps, 4000),
    transcript,
    lang,
    null,
    now(),
    now(),
  );
  const meetingId = Number(
    get<{ id: number }>("SELECT MAX(id) AS id FROM meetings")!.id,
  );

  if (companyId) touchCompany(companyId, heldAt ?? now().slice(0, 10));

  // Agreements the person typed in themselves, before any model sees the text.
  const manual = Array.isArray(body.agreements) ? body.agreements : [];
  let agreements = 0;
  for (const entry of manual.slice(0, 20)) {
    const item = entry as Record<string, unknown>;
    const description = str(item.description, 1000);
    if (!description) continue;
    const deadline = str(item.deadline, 10);
    createAgreement({
      company_id: companyId,
      meeting_id: meetingId,
      description,
      owner_user_id: parseId(item.owner_user_id),
      owner_name: str(item.owner_name, 160),
      deadline: deadline && /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : null,
      priority: oneOf(item.priority, ["PAST", "ORTA", "YUQORI", "KRITIK"] as const, "ORTA"),
      created_by: user.id,
    });
    agreements++;
  }

  // Optional analysis. Long enough to be worth a run, and only when asked.
  let analysis: Awaited<ReturnType<typeof runMeetingIntake>> | null = null;
  if (body.analyze === true && transcript.trim().length >= 40) {
    analysis = await runMeetingIntake(user, meetingId, title, transcript, lang);
    agreements += await agreementsFromAnalysis(meetingId, companyId, user.id);
  }

  return NextResponse.json({
    ok: true,
    id: meetingId,
    agreements,
    analysis: analysis
      ? {
          status: analysis.status,
          created: analysis.created,
          drafts: analysis.drafts,
          keyPoints: analysis.keyPoints ?? [],
          summary: analysis.summary,
        }
      : null,
  });
}

/**
 * Turns what the analysis extracted into agreements on the company's card.
 *
 * The analysis already files its findings as assignment proposals for a human
 * to review; this mirrors the same findings into the CRM as commitments, which
 * is a different question — a proposal asks "should we task somebody with
 * this", an agreement records "this is what we said we would do". One meeting
 * legitimately produces both.
 */
async function agreementsFromAnalysis(
  meetingId: number,
  companyId: number | null,
  createdBy: number,
): Promise<number> {
  const drafts = get<{ ids: string }>(
    `SELECT GROUP_CONCAT(id) AS ids FROM agent_proposals
      WHERE run_id IN (SELECT id FROM agent_runs
                        WHERE source_kind = 'transcript' AND source_ref = ?)
        AND action = 'suggest_task'`,
    String(meetingId),
  );
  if (!drafts?.ids) return 0;

  let made = 0;
  for (const raw of drafts.ids.split(",")) {
    const proposal = get<{ title: string; payload: string | null }>(
      "SELECT title, payload FROM agent_proposals WHERE id = ?",
      Number(raw),
    );
    if (!proposal) continue;
    let payload: { toUserId?: number; deadline?: string | null } = {};
    try {
      payload = proposal.payload ? JSON.parse(proposal.payload) : {};
    } catch {
      /* a malformed payload still yields a usable description */
    }
    createAgreement({
      company_id: companyId,
      meeting_id: meetingId,
      description: proposal.title,
      owner_user_id: payload.toUserId ?? null,
      deadline: payload.deadline ?? null,
      source: "ai",
      created_by: createdBy,
    });
    made++;
  }
  return made;
}

/** Staff the caller may put on the hook, for the form's owner picker. */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  return NextResponse.json({
    staff: assignableUsers(user).map((person) => ({
      id: person.id,
      full_name: person.full_name,
    })),
  });
}
