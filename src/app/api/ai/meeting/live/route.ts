import fs from "node:fs";
import { NextResponse } from "next/server";
import { get, insert, now, run } from "@/lib/pg";
import { currentUser } from "@/lib/session";
import { canSubmitToAi } from "@/lib/agents/access";
import { resolvePath, safeName, store } from "@/lib/uploads";
import { transcribeAudio, transcriptionAvailable } from "@/lib/agents/transcribe";
import {
  EMPTY_STATE,
  recallMemory,
  roomRoster,
  updateLiveState,
  type LiveState,
} from "@/lib/agents/live";
import { oneOf, str } from "@/lib/validate";

/**
 * One round of a meeting that is still happening.
 *
 * The browser calls this about once a minute with only the audio recorded
 * since the last call. The server appends those bytes to the session's
 * recording, transcribes just the new stretch, and — when enough has been said
 * to be worth it — hands the model the running picture plus that stretch and
 * gets the picture back updated.
 *
 * Two things keep this cheap enough to leave running for hours: Whisper never
 * re-hears audio it has already transcribed (`offset_ms`), and the model never
 * re-reads the meeting (`analyzed_len` marks how far it has got). Everything
 * that is constant — the instructions and the staff roster — sits behind a
 * prompt-cache breakpoint and is billed at a tenth of the price from the
 * second round on.
 */

/** A meeting this long has stopped being a meeting. Bounds the spend. */
const MAX_ROUNDS = 200;

/** Below this, the new speech is held for the next round rather than analysed. */
const MIN_SEGMENT = 150;

/** One round's upload. Generous — a minute of Opus is well under a megabyte. */
const MAX_CHUNK = 25 * 1024 * 1024;

interface LiveRow {
  id: number;
  owner_id: number;
  title: string;
  lang: string;
  audio_key: string | null;
  offset_ms: number;
  transcript: string;
  analyzed_len: number;
  state: string | null;
  rounds: number;
}

function readState(row: LiveRow): LiveState {
  if (!row.state) return EMPTY_STATE;
  try {
    return JSON.parse(row.state) as LiveState;
  } catch {
    return EMPTY_STATE;
  }
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canSubmitToAi(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  if (!transcriptionAvailable())
    return NextResponse.json({ error: "STT_UNAVAILABLE" }, { status: 503 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "BAD_FORM" }, { status: 400 });
  }

  const blob = form.get("audio");
  if (!(blob instanceof File) || blob.size === 0)
    return NextResponse.json({ error: "NO_AUDIO" }, { status: 400 });
  if (blob.size > MAX_CHUNK)
    return NextResponse.json({ error: "TOO_LARGE" }, { status: 413 });

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const lang = oneOf(
    form.get("lang"),
    ["auto", "uz-UZ", "ru-RU", "en-US"] as const,
    "auto",
  );

  /* ---- the session row: created on the first round, resumed after ---- */

  const sessionId = Number(form.get("session"));
  let row: LiveRow | undefined;

  if (Number.isInteger(sessionId) && sessionId > 0) {
    row = await get<LiveRow>(
      "SELECT * FROM meeting_live WHERE id = ?",
      sessionId,
    );
    // Someone else's meeting is not yours to append to.
    if (!row || row.owner_id !== user.id)
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    if (row.rounds >= MAX_ROUNDS)
      return NextResponse.json({ error: "TOO_LONG" }, { status: 413 });
  } else {
    const title = str(form.get("title"), 160) ?? "Uchrashuv";
    // The first chunk carries the container header, so it is the file.
    const stored = store(bytes, "voice", "audio/webm", safeName("meeting", "voice"));
    // RETURNING, not `SELECT MAX(id)`: two people can start a meeting in the
    // same second, and then the highest id is not the row this call wrote.
    const created = await insert(
      `INSERT INTO meeting_live (owner_id, title, lang, audio_key, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
      user.id,
      title,
      lang,
      stored.key,
      now(),
      now(),
    );
    row = (await get<LiveRow>(
      "SELECT * FROM meeting_live WHERE id = ?",
      created,
    ))!;
  }

  const path = row.audio_key ? resolvePath(row.audio_key) : null;
  if (!path) return NextResponse.json({ error: "BAD_AUDIO" }, { status: 400 });

  // Later chunks are continuations of the same stream, so appending the raw
  // bytes reproduces exactly the file the browser would have produced at the
  // end — no re-upload of what was already sent.
  if (row.rounds > 0 || row.offset_ms > 0) {
    fs.appendFileSync(path, bytes);
  }

  /* ---- hear the new stretch ---- */

  const heard = await transcribeAudio(path, lang, row.offset_ms);
  if (typeof heard === "string" && heard !== "EMPTY") {
    return NextResponse.json({ error: heard }, { status: 422 });
  }

  const fresh = typeof heard === "string" ? "" : heard.text.trim();
  const seconds = typeof heard === "string" ? null : heard.seconds;
  const transcript = fresh
    ? `${row.transcript}${row.transcript ? " " : ""}${fresh}`
    : row.transcript;

  await run(
    `UPDATE meeting_live
        SET transcript = ?, offset_ms = ?, rounds = rounds + 1, updated_at = ?
      WHERE id = ?`,
    transcript,
    seconds !== null ? Math.floor(seconds * 1000) : row.offset_ms,
    now(),
    row.id,
  );

  /* ---- update the picture, when there is enough new speech to justify it ---- */

  const segment = transcript.slice(row.analyzed_len);
  let state = readState(row);
  let analysed = false;

  if (segment.trim().length >= MIN_SEGMENT) {
    const update = await updateLiveState(
      state,
      segment,
      await roomRoster(),
      lang,
      await recallMemory(),
      row.title,
    );

    if (update) {
      state = {
        keyPoints: update.keyPoints,
        decisions: update.decisions,
        plan: update.plan,
        questions: update.questions,
      };
      analysed = true;
      await run(
        `UPDATE meeting_live
            SET state = ?, analyzed_len = ?,
                tokens_in = tokens_in + ?, tokens_out = tokens_out + ?,
                updated_at = ?
          WHERE id = ?`,
        JSON.stringify(state),
        transcript.length,
        update.tokensIn,
        update.tokensOut,
        now(),
        row.id,
      );
    }
  }

  return NextResponse.json({
    session: row.id,
    transcript,
    state,
    analysed,
    seconds,
  });
}
