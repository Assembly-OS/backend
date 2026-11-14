import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { decideMany } from "@/lib/agents/orchestrator";
import { oneOf } from "@/lib/validate";

/**
 * Several proposals approved or rejected at once (TZ 7.1 "ommaviy
 * tasdiqlash"). Approval here takes each draft as the model wrote it; a
 * draft that needs correcting is approved one at a time with its edits.
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { ids?: unknown; decision?: unknown };
  const ids = Array.isArray(body.ids)
    ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 100)
    : [];
  if (ids.length === 0) return NextResponse.json({ error: "NO_IDS" }, { status: 400 });
  const decision = oneOf(body.decision, ["approve", "reject"] as const, "reject");
  const results = await decideMany(ids, decision, user);
  return NextResponse.json({ ok: true, results, done: results.filter((r) => r.ok).length });
}
