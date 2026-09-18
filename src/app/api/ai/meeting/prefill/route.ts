import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canWrite } from "@/lib/crm-access";
import { isConfigured } from "@/lib/agents/claude";
import { prefillMeeting } from "@/lib/agents/intake-runner";
import { id as parseId, oneOf, str } from "@/lib/validate";

/**
 * The meeting form's "fill from the transcript": the transcript in the form
 * goes in, a proposal for each field comes back.
 *
 * Nothing is written to a meeting here. The form puts each proposal into a
 * field that is still empty, marked as the AI's, and the person saves it or
 * not — the TZ's "the AI fills the fields, as a suggestion; a person reviews
 * them". It works on a meeting not saved yet, which is when a pasted
 * transcript most needs it.
 *
 * Open to anybody who may file a meeting, like the analysis on the same form:
 * a press costs one model call, and it is logged with the agent's other runs.
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canWrite(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const transcript = str(body.transcript, 200_000) ?? "";
  if (transcript.trim().length < 40)
    return NextResponse.json({ error: "TRANSCRIPT_TOO_SHORT" }, { status: 400 });
  if (!isConfigured())
    return NextResponse.json({ error: "AI_UNAVAILABLE" }, { status: 503 });

  const suggestion = await prefillMeeting(user, {
    // Only for the log: which meeting the press was made on, if it exists yet.
    meetingId: parseId(body.meeting_id),
    title: str(body.title, 160) ?? "Uchrashuv",
    transcript,
    lang: oneOf(body.lang, ["auto", "uz-UZ", "ru-RU", "en-US"] as const, "auto"),
  });
  if (!suggestion)
    return NextResponse.json({ error: "AI_FAILED" }, { status: 502 });

  return NextResponse.json({ suggestion });
}
