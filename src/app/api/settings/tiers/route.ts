import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { seesEverything } from "@/lib/oversight";
import { mergeSignalSettings, mergeTierSettings } from "@/lib/signal-rules";
import { SIGNAL_SETTINGS_KEY, TIER_SETTINGS_KEY, signalSettings, tierSettings, writeSetting } from "@/lib/settings";

/** The review rhythm and red-share limit per tier (8.2), the signal thresholds (7.5). */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  return NextResponse.json({ tiers: await tierSettings(), signals: await signalSettings() });
}

export async function PATCH(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!seesEverything(user)) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { tiers?: unknown; signals?: unknown };
  if (body.tiers !== undefined) await writeSetting(TIER_SETTINGS_KEY, mergeTierSettings(body.tiers), user.id);
  if (body.signals !== undefined) await writeSetting(SIGNAL_SETTINGS_KEY, mergeSignalSettings(body.signals), user.id);
  return NextResponse.json({ ok: true, tiers: await tierSettings(), signals: await signalSettings() });
}
