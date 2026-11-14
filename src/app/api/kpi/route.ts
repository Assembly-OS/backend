import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { kpiBoard, kpiRollup, seesRollup } from "@/lib/kpi";
import { kpiBounds, type KpiPeriod } from "@/lib/kpi-rules";
import { kpiSettings } from "@/lib/settings";

/** The cards in the asker's reach for one period, with the roll-up. */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const url = new URL(request.url);
  const period: KpiPeriod = url.searchParams.get("period") === "quarter" ? "quarter" : "month";
  const raw = Number(url.searchParams.get("offset"));
  const offset = Number.isInteger(raw) ? Math.min(0, Math.max(-12, raw)) : 0;
  const bounds = kpiBounds(period, offset);
  const settings = await kpiSettings();
  const cards = await kpiBoard(user, bounds, settings);
  const rollup = seesRollup(user) ? await kpiRollup(user, cards, settings) : null;
  return NextResponse.json({ bounds, cards, rollup, settings });
}
