import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { proposalsFor } from "@/lib/agents/orchestrator";
import { id as parseId, str } from "@/lib/validate";

/** The reviewer's queue, filtered and paged (TZ 7.1). */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  const q = new URL(request.url).searchParams;
  const day = (value: string | null) => {
    const text = str(value, 10);
    return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
  };
  return NextResponse.json(
    await proposalsFor(user.id, {
      status: str(q.get("status"), 20),
      severity: str(q.get("severity"), 2),
      assigneeId: parseId(q.get("assignee")),
      agent: str(q.get("agent"), 40),
      from: day(q.get("from")),
      to: day(q.get("to")),
      page: Number(q.get("page")) || 1,
    }),
  );
}
