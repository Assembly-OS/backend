import { NextResponse } from "next/server";
import { hasAdminSession, ADMIN_LOGIN } from "@/lib/admin-auth";
import { runAgent } from "@/lib/agents/orchestrator";
import { str } from "@/lib/validate";

/**
 * Runs one agent. The administration session is the trigger's authority — an
 * agent has no way to start itself, which is half of what keeps the ecosystem
 * bounded (TZ §10.1).
 */
export async function POST(request: Request) {
  if (!(await hasAdminSession()))
    return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const body = (await request.json()) as { agent?: unknown };
  const agent = str(body.agent, 40);
  if (!agent) return NextResponse.json({ error: "REQUIRED" }, { status: 400 });

  const result = await runAgent(agent, "manual", ADMIN_LOGIN);
  return NextResponse.json(result);
}
