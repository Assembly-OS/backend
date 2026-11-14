import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { personKpi } from "@/lib/kpi";
import { kpiBounds, type KpiPeriod } from "@/lib/kpi-rules";
import { id as parseId } from "@/lib/validate";

/** One person's card — for the people TZ 4.2 lets see it. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  const userId = parseId((await params).userId);
  if (!userId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const url = new URL(request.url);
  const period: KpiPeriod = url.searchParams.get("period") === "quarter" ? "quarter" : "month";
  const raw = Number(url.searchParams.get("offset"));
  const offset = Number.isInteger(raw) ? Math.min(0, Math.max(-12, raw)) : 0;
  const card = await personKpi(user, userId, kpiBounds(period, offset));
  if (!card) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ card });
}
