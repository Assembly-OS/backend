import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { seesEverything } from "@/lib/oversight";
import { mergeAiSettings } from "@/lib/signal-rules";
import { AI_SETTINGS_KEY, aiSettings, writeSetting } from "@/lib/settings";

/** The AI queue's switches (TZ 7.1): auto-approval of low-risk proposals, expiry. */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  return NextResponse.json({ settings: await aiSettings() });
}

export async function PATCH(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!seesEverything(user)) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as unknown;
  const settings = mergeAiSettings({ ...(await aiSettings()), ...(body && typeof body === "object" ? body : {}) });
  await writeSetting(AI_SETTINGS_KEY, settings, user.id);
  return NextResponse.json({ ok: true, settings });
}
