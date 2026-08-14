import { NextResponse } from "next/server";
import { get, now, run } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { runMeetingIntake } from "@/lib/agents/intake-runner";
import { canSubmitToAi } from "@/lib/agents/access";
import { resolvePath, safeName, store } from "@/lib/uploads";
import { transcribeAudio, transcriptionAvailable } from "@/lib/agents/transcribe";
import { oneOf, str } from "@/lib/validate";

/**
 * A recorded meeting arrives here as audio, as a transcript, or as both.
 *
 * The browser transcribes live where it can — the Web Speech API turns speech
 * into text while the recorder runs, and watching the words appear is worth
 * having. Where it cannot, the audio is transcribed here instead, by a local
 * Whisper model. Firefox has no speech API at all and Safari refuses without
 * macOS Dictation enabled, which on a managed machine is not the user's call to
 * make; neither should decide whether a meeting can be minuted.
 */

/**
 * A meeting recording is not a voice note — an hour of audio is normal and
 * must not be rejected by the chat attachment ceiling.
 */
const MAX_AUDIO = 200 * 1024 * 1024;
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canSubmitToAi(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "BAD_FORM" }, { status: 400 });
  }

  const typed = str(form.get("transcript"), 200_000);
  const title = str(form.get("title"), 160) ?? "Uchrashuv";
  // The three languages the Assembly actually works in.
  const lang = oneOf(
    form.get("lang"),
    ["auto", "uz-UZ", "ru-RU", "en-US"] as const,
    "auto",
  );
  const rawDuration = Number(form.get("duration"));
  const duration =
    Number.isFinite(rawDuration) && rawDuration > 0
      ? Math.round(rawDuration)
      : null;

  // A meeting that was followed live arrives already transcribed and already
  // recorded — the live rounds did both, minute by minute. Re-doing either
  // here would be an hour of CPU spent hearing what we heard as it was said.
  const liveId = Number(form.get("live"));
  const live =
    Number.isInteger(liveId) && liveId > 0
      ? get<{
          id: number;
          owner_id: number;
          audio_key: string | null;
          transcript: string;
        }>("SELECT * FROM meeting_live WHERE id = ?", liveId)
      : undefined;
  if (live && live.owner_id !== user.id) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  // The audio is kept whether or not it was needed for the text: it is the
  // record of what was actually said, and a disputed decision gets settled by
  // listening, not by re-reading a machine transcript.
  let audioKey: string | null = live?.audio_key ?? null;
  const audio = form.get("audio");
  if (
    !audioKey &&
    audio instanceof File &&
    audio.size > 0 &&
    audio.size <= MAX_AUDIO
  ) {
    const stored = store(
      new Uint8Array(await audio.arrayBuffer()),
      "voice",
      audio.type || "audio/webm",
      safeName(audio.name ?? "meeting", "voice"),
    );
    audioKey = stored.key;
  }

  // Preference order: what the live rounds already heard, then what the
  // browser heard, then — only if neither exists — Whisper on the whole file.
  let transcript = live?.transcript?.trim() || typed || "";
  let transcribedHere = Boolean(live);
  if (transcript.trim().length < 40 && audioKey) {
    const path = resolvePath(audioKey);
    if (!path) {
      return NextResponse.json({ error: "BAD_AUDIO" }, { status: 400 });
    }
    if (!transcriptionAvailable()) {
      return NextResponse.json({ error: "STT_UNAVAILABLE" }, { status: 503 });
    }
    const result = await transcribeAudio(path, lang);
    if (typeof result === "string") {
      return NextResponse.json({ error: result }, { status: 422 });
    }
    transcript = result.text;
    transcribedHere = true;
  }

  if (transcript.trim().length < 40) {
    return NextResponse.json({ error: "TRANSCRIPT_TOO_SHORT" }, { status: 400 });
  }

  run(
    `INSERT INTO meetings (title, owner_id, audio_key, duration, transcript, lang, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    title,
    user.id,
    audioKey,
    duration,
    transcript,
    lang,
    now(),
  );
  const meetingId = Number(
    get<{ id: number }>("SELECT MAX(id) AS id FROM meetings")!.id,
  );

  // The live session has done its job; the meeting row owns the recording and
  // the transcript now. Leaving it would double-count the audio on disk.
  if (live) {
    run("DELETE FROM meeting_live WHERE id = ?", live.id);
  }

  const result = await runMeetingIntake(
    user,
    meetingId,
    title,
    transcript,
    lang,
  );
  // `transcript` goes back so the page can show what the server heard — the
  // person who ran the meeting is the only one who can tell a mishearing from
  // a decision, and they should see it, not just its consequences.
  return NextResponse.json({
    ...result,
    meetingId,
    transcribedHere,
    transcript: transcribedHere ? transcript : undefined,
  });
}
