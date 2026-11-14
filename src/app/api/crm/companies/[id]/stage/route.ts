import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canWrite } from "@/lib/crm-access";
import { companyById, moveStage, stageHistory } from "@/lib/crm";
import { isStage } from "@/lib/crm-stages";
import { remember } from "@/lib/knowledge/sources";
import { id as parseId, str } from "@/lib/validate";

type Params = { params: Promise<{ id: string }> };

/** The company's moves along the path, newest first. */
export async function GET(_request: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  const companyId = parseId((await params).id);
  if (!companyId || !(await companyById(companyId)))
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ history: await stageHistory(companyId) });
}

/** Moves a company to a stage by hand, with a note (TZ 6.2). */
export async function POST(request: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canWrite(user)) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const companyId = parseId((await params).id);
  if (!companyId || !(await companyById(companyId)))
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (!isStage(body.stage)) return NextResponse.json({ error: "BAD_STAGE" }, { status: 400 });
  const moved = await moveStage(companyId, body.stage, user.id, { reason: "manual", note: str(body.note, 1000) });
  if (moved) {
    // The company's meetings and agreements already sit in the memory; the
    // stage change reaches it through them, nothing to read here.
    void remember;
  }
  return NextResponse.json({ ok: true, moved });
}
