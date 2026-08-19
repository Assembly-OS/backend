import { insert, now } from "../pg";
import { resolvePath, safeName, store } from "../uploads";
import { transcribeAudio, transcriptionAvailable } from "./transcribe";
import { runMeetingIntake } from "./intake-runner";
import type { User } from "../types";

/**
 * Turning a recording into a minuted meeting.
 *
 * One function, because there are now two doors into it and they must not
 * drift apart. The web page uploads a file it recorded itself; the bot
 * forwards a voice message somebody sent in Telegram. What happens after the
 * audio arrives — store it, transcribe it, write the meeting, run the
 * analysis — is the same work, and a second copy of it would be a second
 * place for the transcript rules to be subtly different.
 */

/** An hour of audio is a normal meeting, not an oversized attachment. */
export const MAX_AUDIO = 200 * 1024 * 1024;

/** Below this a "transcript" is noise, not a meeting worth analysing. */
const MIN_TRANSCRIPT = 40;

export type IngestFailure =
  | "BAD_AUDIO"
  | "STT_UNAVAILABLE"
  | "TRANSCRIPT_TOO_SHORT"
  | "UNAVAILABLE"
  | "TOO_LONG"
  | "FAILED"
  | "EMPTY";

export interface IngestInput {
  user: User;
  title: string;
  lang: string;
  /** Already-stored audio (the live session's), or bytes to store now. */
  audioKey?: string | null;
  audio?: { bytes: Uint8Array; mime: string; name: string } | null;
  /** Text the browser or a live round already heard. */
  transcript?: string;
  duration?: number | null;
}

export interface IngestResult {
  meetingId: number;
  transcript: string;
  transcribedHere: boolean;
  intake: Awaited<ReturnType<typeof runMeetingIntake>>;
}

export async function ingestMeeting(
  input: IngestInput,
): Promise<IngestResult | IngestFailure> {
  // The audio is kept whether or not it was needed for the text: it is the
  // record of what was actually said, and a disputed decision gets settled by
  // listening, not by re-reading a machine transcript.
  let audioKey = input.audioKey ?? null;
  if (!audioKey && input.audio && input.audio.bytes.length > 0) {
    if (input.audio.bytes.length > MAX_AUDIO) return "TOO_LONG";
    audioKey = store(
      input.audio.bytes,
      "voice",
      input.audio.mime || "audio/ogg",
      safeName(input.audio.name || "meeting", "voice"),
    ).key;
  }

  let transcript = (input.transcript ?? "").trim();
  let transcribedHere = false;

  if (transcript.length < MIN_TRANSCRIPT && audioKey) {
    const path = resolvePath(audioKey);
    if (!path) return "BAD_AUDIO";
    if (!transcriptionAvailable()) return "STT_UNAVAILABLE";
    const result = await transcribeAudio(path, input.lang);
    if (typeof result === "string") return result;
    transcript = result.text;
    transcribedHere = true;
  }

  if (transcript.length < MIN_TRANSCRIPT) return "TRANSCRIPT_TOO_SHORT";

  // RETURNING rather than a following SELECT MAX(id): with the bot, the web
  // app and the sweep all writing, the highest id need not be the row this
  // call just inserted.
  const meetingId = await insert(
    `INSERT INTO meetings (title, owner_id, audio_key, duration, transcript, lang, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    input.title,
    input.user.id,
    audioKey,
    input.duration ?? null,
    transcript,
    input.lang,
    now(),
  );

  const intake = await runMeetingIntake(
    input.user,
    meetingId,
    input.title,
    transcript,
    input.lang,
  );

  return { meetingId, transcript, transcribedHere, intake };
}
