import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { seesEverything } from "@/lib/oversight";
import { mergeStageLimits } from "@/lib/crm-stages";
import { readSetting, writeSetting } from "@/lib/settings";

export const CRM_SETTINGS_KEY = "crm";

/** The days a company may sit at each stage before it reads as stuck. */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  const stored = await readSetting<{ stageLimits?: unknown }>(CRM_SETTINGS_KEY);
  return NextResponse.json({ stageLimits: mergeStageLimits(stored?.stageLimits) });
}

export async function PATCH(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!seesEverything(user)) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { stageLimits?: unknown };
  const stageLimits = mergeStageLimits(body.stageLimits);
  await writeSetting(CRM_SETTINGS_KEY, { stageLimits }, user.id);
  return NextResponse.json({ ok: true, stageLimits });
}
