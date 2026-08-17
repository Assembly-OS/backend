import { spawn } from "node:child_process";
import fs from "node:fs";

/**
 * Speech to text on the server, so a meeting can be recorded from any browser.
 *
 * The browser's own recognition is still tried first — it is live, and seeing
 * the words appear while the meeting runs is worth a lot. But it is not
 * something we can rely on: Firefox has no such API at all, and Safari refuses
 * unless macOS Dictation is switched on, which on a managed machine is not the
 * user's decision to make. When it refuses, the recorder captures audio instead
 * and the file lands here.
 *
 * This runs locally: `whisper.cpp` with a downloaded model, no second vendor,
 * no key, no audio leaving the building — which for a meeting of the Assembly's
 * leadership is the point, not a detail. It costs nothing per minute, so a long
 * meeting is a question of patience rather than budget.
 */

/**
 * Recognition languages the platform offers, mapped to Whisper's codes.
 *
 * `auto` is the default and the honest one: a negotiation at the Assembly is
 * routinely held in three languages, often inside one sentence. Naming a
 * language is an override for the meeting that genuinely is monolingual — it
 * makes Whisper resolve a mangled word towards that language, which helps when
 * it is true and hurts when it is not.
 */
const LANGS: Record<string, string> = {
  auto: "auto",
  "uz-UZ": "uz",
  "ru-RU": "ru",
  "en-US": "en",
};

/**
 * The model lives outside the project on purpose: it is 1.5 GB, and anything
 * under the project root gets walked by the bundler's file tracing on every
 * build.
 */
const MODEL =
  process.env.WHISPER_MODEL ||
  `${process.env.HOME ?? "/tmp"}/.assembleya/whisper/ggml-large-v3-turbo.bin`;

/**
 * Voice activity detection. Without it Whisper is handed silence and, having
 * been trained on subtitle files, fills it with the credits it saw there —
 * "Субтитры создавал…", "Продолжение следует", "Thanks for watching". Those
 * lines then read as things somebody said in the meeting. VAD cuts the silence
 * out before the model ever sees it, which removes the cause rather than
 * filtering the symptom.
 */
const VAD_MODEL =
  process.env.WHISPER_VAD_MODEL ||
  `${process.env.HOME ?? "/tmp"}/.assembleya/whisper/ggml-silero-v5.1.2.bin`;
const WHISPER = process.env.WHISPER_BIN || "/opt/homebrew/bin/whisper-cli";
const FFMPEG = process.env.FFMPEG_BIN || "/opt/homebrew/bin/ffmpeg";

/** A meeting longer than this is refused rather than run for an hour. */
const MAX_SECONDS = Number(process.env.WHISPER_MAX_SECONDS ?? 7200);

export function transcriptionAvailable(): boolean {
  return (
    fs.existsSync(/* turbopackIgnore: true */ MODEL) &&
    fs.existsSync(/* turbopackIgnore: true */ WHISPER) &&
    fs.existsSync(/* turbopackIgnore: true */ FFMPEG)
  );
}

/** Runs a command to completion, capturing stdout. Never inherits a shell. */
function exec(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    // Bounded: whisper prints a progress line per segment, and a long meeting
    // would otherwise accumulate megabytes of it in memory.
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 4_000_000) stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 200_000) stderr += String(chunk);
    });

    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Seconds of audio actually decodable from the file.
 *
 * Measured by decoding, not by reading the container header. The header is
 * unreliable for exactly the files this handles: a recording still being
 * appended to has no final duration, and one cut mid-stream keeps whatever
 * duration was written when it was created. Trusting it moved the resume point
 * past speech nobody had transcribed yet, and that minute was simply lost.
 *
 * The `time=` figure on ffmpeg's last progress line is how far it got, which
 * is the honest answer in both cases.
 */
async function durationOf(input: string): Promise<number | null> {
  const probe = await exec(
    FFMPEG,
    ["-hide_banner", "-i", input, "-f", "null", "-"],
    120_000,
  );
  const decoded = [...probe.stderr.matchAll(/time=(\d+):(\d\d):(\d\d)\.(\d+)/g)];
  const last = decoded.at(-1);
  if (last) {
    return (
      Number(last[1]) * 3600 +
      Number(last[2]) * 60 +
      Number(last[3]) +
      Number(`0.${last[4]}`)
    );
  }
  // No progress line at all (a very short clip decodes before the first tick).
  const header = /Duration: (\d+):(\d\d):(\d\d)\.(\d+)/.exec(probe.stderr);
  if (!header) return null;
  return (
    Number(header[1]) * 3600 + Number(header[2]) * 60 + Number(header[3])
  );
}

export type TranscribeFailure =
  | "UNAVAILABLE"
  | "TOO_LONG"
  | "BAD_AUDIO"
  | "FAILED"
  | "EMPTY";

export interface TranscribeResult {
  text: string;
  seconds: number | null;
}

/**
 * Transcribes one recording. `lang` is the language the speaker selected;
 * Whisper is told which to expect rather than guessing, because a meeting in
 * Uzbek misdetected as Turkish comes back as confident nonsense.
 *
 * `offsetMs` resumes from a point already transcribed, which is what makes a
 * meeting analysable while it is still running: each round the browser uploads
 * the whole recording so far, and only the minute nobody has heard yet is fed
 * through the model. Without it, a one-hour meeting would be re-transcribed
 * sixty times.
 */
export async function transcribeAudio(
  audioPath: string,
  lang: string,
  offsetMs = 0,
): Promise<TranscribeResult | TranscribeFailure> {
  if (!transcriptionAvailable()) return "UNAVAILABLE";
  if (!fs.existsSync(audioPath)) return "BAD_AUDIO";

  const seconds = await durationOf(audioPath);
  if (seconds !== null && seconds > MAX_SECONDS) return "TOO_LONG";
  // Nothing new since the last round.
  if (seconds !== null && offsetMs > 0 && seconds * 1000 <= offsetMs + 1500) {
    return { text: "", seconds };
  }

  // Whisper wants 16 kHz mono PCM; browsers hand us Opus in a WebM container.
  const stem = `${audioPath}.stt`;
  const wav = `${stem}.wav`;
  try {
    const convert = await exec(
      FFMPEG,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        audioPath,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        wav,
      ],
      // Conversion is I/O bound and fast; a minute is already generous.
      120_000,
    );
    if (convert.code !== 0 || !fs.existsSync(wav)) return "BAD_AUDIO";

    const run = await exec(
      WHISPER,
      [
        "-m", MODEL,
        "-f", wav,
        "-l", LANGS[lang] ?? "auto",
        // Silence is where the hallucinations come from; never show it to the
        // model. Falls back silently to plain decoding if the model is absent.
        ...(fs.existsSync(/* turbopackIgnore: true */ VAD_MODEL)
          ? ["--vad", "--vad-model", VAD_MODEL, "--vad-threshold", "0.5"]
          : []),
        // Drop the bracketed [MUSIC] / (шум) tokens rather than transcribing
        // them as speech.
        "-sns",
        // A window the decoder is unsure about is discarded instead of being
        // guessed at — the default is lenient enough to invent a sentence.
        "--no-speech-thold", "0.7",
        // Resume point. `-ot` is the start offset in ms — not to be confused
        // with `-of`, the output-file prefix two lines below.
        "-ot", String(Math.max(0, Math.floor(offsetMs))),
        "-otxt",           // write <stem>.txt next to the wav
        "-of", stem,
        "-nt",             // no timestamps: the analysis wants prose
        "-np",             // no progress bar
        "-t", "4",         // threads; the Metal backend does the heavy lifting
      ],
      // Roughly real time on Apple Silicon with the turbo model, with a wide
      // margin for a machine that is also serving the platform.
      Math.max(600_000, (seconds ?? 600) * 4000),
    );
    if (run.code !== 0) return "FAILED";

    const outFile = `${stem}.txt`;
    const text = fs.existsSync(outFile)
      ? fs.readFileSync(outFile, "utf8").trim()
      : run.stdout.trim();

    // Whisper was trained on subtitle files, so on near-silence it reaches for
    // the boilerplate those files end with. VAD removes almost all of it; this
    // catches the rest, because one invented line in a meeting record is worse
    // than a missing one.
    const JUNK = [
      /субтитры\s+(создавал|делал|подготовил)/i,
      /продолжение следует/i,
      /amara\.?org/i,
      /редактор субтитров/i,
      /подписывайтесь|подпишись/i,
      /thanks?\s+for\s+watching/i,
      /subscribe|like and subscribe/i,
      /^\s*субтитры\s*$/i,
      /корректор\s+/i,
    ];

    // Whisper emits bracketed markers for music and silence; on a recording
    // that captured nothing they are the entire output.
    const cleaned = text
      .split("\n")
      .map((line) => line.replace(/^\[[^\]]*\]\s*/, "").trim())
      .filter((line) => line && !/^\[.*\]$/.test(line))
      .filter((line) => !JUNK.some((pattern) => pattern.test(line)))
      .join(" ")
      .replace(/\s{2,}/g, " ")
      .trim();

    if (!cleaned) return "EMPTY";
    return { text: cleaned, seconds };
  } finally {
    for (const leftover of [wav, `${stem}.txt`]) {
      try {
        fs.unlinkSync(leftover);
      } catch {
        /* never written, or already gone */
      }
    }
  }
}
