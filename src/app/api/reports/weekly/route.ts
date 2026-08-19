import { NextResponse } from "next/server";
import { all } from "@/lib/pg";
import { currentUser } from "@/lib/session";
import { renderWeeklyText, weeklyReport } from "@/lib/reports";
import { isManager } from "@/lib/types";

/**
 * The weekly report, in two shapes for two callers:
 *
 *  - `?format=json` — the page, for a signed-in manager.
 *  - `?format=text` — the Telegram digest, for the bot. The bot has no session,
 *    so it presents the shared notify secret instead; the same secret already
 *    guards the push in the other direction.
 *
 * `?offset=-1` selects last week; 0 (the default) is the current one.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const format = params.get("format") === "text" ? "text" : "json";
  const offset = Number(params.get("offset")) || 0;

  const secret = process.env.BOT_NOTIFY_SECRET;
  const presented = request.headers.get("x-notify-secret");
  const fromBot = Boolean(secret && presented && presented === secret);

  if (!fromBot) {
    const user = await currentUser();
    if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
    // The report summarises everyone, so it is a manager's view.
    if (!isManager(user.role))
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const report = await weeklyReport(offset);

  if (format === "text") {
    return NextResponse.json({
      text: renderWeeklyText(report, process.env.PLATFORM_PUBLIC_URL ?? ""),
      week: report.week,
      // Who should receive it: everyone who commands a vertical and has
      // linked Telegram. The bot resolves nothing itself.
      recipients: fromBot
        ? (
            await all<{ id: number; telegram_id: number | null }>(
              `SELECT id, telegram_id FROM users
                WHERE is_active = 1 AND telegram_id IS NOT NULL
                  AND role IN ('RAIS','UYUSHMA_RAISI','LOYIHA_RAHBARI','BOLIM_RAHBARI','AI_LAB')`,
            )
          ).map((row) => row.id)
        : [],
    });
  }

  return NextResponse.json(report);
}
