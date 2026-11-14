import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { seesEverything } from "@/lib/oversight";
import { mergeSettings } from "@/lib/kpi-rules";
import { kpiSettings, kpiSettingsMeta, KPI_SETTINGS_KEY, writeSetting } from "@/lib/settings";

/** The KPI model's settings, as stored over the defaults. */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  return NextResponse.json({ settings: await kpiSettings(), ...(await kpiSettingsMeta()) });
}

/**
 * Changes the ratios, thresholds, limits or targets. The chairman's (and his
 * assistant's): TZ 5.2 says the final values are the customer's to confirm.
 * Everything is checked and completed from the defaults before it is stored,
 * so a half-filled form cannot leave a role without a ratio.
 */
export async function PATCH(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!seesEverything(user)) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const body = (await request.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object")
    return NextResponse.json({ error: "BAD_BODY" }, { status: 400 });

  // Merge over what is stored, not over the defaults alone: the form sends
  // only the section it edited.
  const current = await kpiSettings();
  const merged = mergeSettings({ ...current, ...(body as object) });
  await writeSetting(KPI_SETTINGS_KEY, merged, user.id);
  return NextResponse.json({ ok: true, settings: merged });
}
