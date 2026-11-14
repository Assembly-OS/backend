import { NextResponse } from "next/server";
import { runPending } from "@/lib/knowledge/jobs";

/**
 * One pass over the memory's queue, on request.
 *
 * The web process runs its own passes; this is for the bot's minute loop
 * or an external scheduler, so the queue keeps moving even when the web
 * process is being restarted. Guarded by the same shared secret the bot
 * already uses — no session, and not reachable by anyone who finds the URL.
 */
export async function POST(request: Request) {
  const secret = process.env.NOTIFY_SECRET || process.env.BOT_NOTIFY_SECRET;
  if (!secret || request.headers.get("X-Notify-Secret") !== secret) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }
  return NextResponse.json(await runPending({ budgetMs: 50_000, max: 30 }));
}
