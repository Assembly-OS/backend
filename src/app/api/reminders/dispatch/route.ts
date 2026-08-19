import { NextResponse } from "next/server";
import { sweepReminders } from "@/lib/notifications";

/**
 * The bot's minute loop calls this so reminders fire even when nobody has the
 * platform open. Guarded by the same shared secret the bot already uses for
 * its own notify webhook — this endpoint has no session and must not be
 * reachable by anyone who happens to find the URL.
 */
export async function POST(request: Request) {
  const secret = process.env.NOTIFY_SECRET || process.env.BOT_NOTIFY_SECRET;
  if (secret && request.headers.get("X-Notify-Secret") !== secret) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }
  return NextResponse.json({ fired: await sweepReminders() });
}
