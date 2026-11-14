import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { isManager } from "@/lib/types";
import { clusterHealth, interventions, projectHealth, signals, upcomingDecisions } from "@/lib/signals";

/** The six signals and the chairman's blocks, for the dashboard and the bot. */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!isManager(user.role)) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const url = new URL(request.url);
  const days = Math.max(1, Math.min(90, Number(url.searchParams.get("days")) || 14));
  const health = await projectHealth(user);
  return NextResponse.json({
    signals: await signals(user, health),
    clusters: await clusterHealth(health),
    interventions: interventions(health),
    upcoming: upcomingDecisions(health, days),
  });
}
