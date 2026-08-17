import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { get } from "@/lib/db";
import { canSubmitToAi } from "@/lib/agents/access";
import { ingestMeeting, MAX_AUDIO } from "@/lib/agents/meeting-ingest";
import { oneOf, str } from "@/lib/validate";
import type { User } from "@/lib/types";

/**
 * A meeting sent as a Telegram voice message.
 *
 * Telegram will not always hand a Mini App the microphone — on iOS it simply
 * does not — so the recording that a phone *can* always make is the one
 * Telegram makes itself. The bot forwards that voice note here and the
 * meeting is minuted exactly as if it had been uploaded from the web page.
 *
 * The caller is the bot, not a person, so there is no session to read. It
 * authenticates with the secret the two already share for notifications, and
 * names the Telegram account the audio came from; the platform decides for
 * itself which member of staff that is. The bot never asserts an identity —
 * it reports a Telegram id, and only a link made through a real sign-in turns
 * that into a person.
 */

function authorised(request: Request): boolean {
  const expected = process.env.BOT_NOTIFY_SECRET?.trim();
  // No secret configured means this door stays shut, rather than open.
  if (!expected) return false;
  const given = request.headers.get("x-notify-secret") ?? "";
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  if (!authorised(request))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "BAD_FORM" }, { status: 400 });
  }

  const telegramId = Number(form.get("telegram_id"));
  if (!Number.isFinite(telegramId) || telegramId <= 0)
    return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const user = get<User>(
    "SELECT * FROM users WHERE telegram_id = ? AND is_active = 1",
    telegramId,
  );
  if (!user) return NextResponse.json({ error: "NOT_LINKED" }, { status: 404 });
  if (!canSubmitToAi(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const audio = form.get("audio");
  if (!(audio instanceof File) || audio.size === 0)
    return NextResponse.json({ error: "NO_AUDIO" }, { status: 400 });
  if (audio.size > MAX_AUDIO)
    return NextResponse.json({ error: "TOO_LONG" }, { status: 413 });

  const result = await ingestMeeting({
    user,
    title: str(form.get("title"), 160) ?? "Ovozli xabar",
    lang: oneOf(
      form.get("lang"),
      ["auto", "uz-UZ", "ru-RU", "en-US"] as const,
      "auto",
    ),
    audio: {
      bytes: new Uint8Array(await audio.arrayBuffer()),
      mime: audio.type || "audio/ogg",
      name: audio.name || "voice.ogg",
    },
  });

  if (typeof result === "string")
    return NextResponse.json({ error: result }, { status: 422 });

  return NextResponse.json({
    meetingId: result.meetingId,
    transcript: result.transcript,
    ...result.intake,
  });
}
