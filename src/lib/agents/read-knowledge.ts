import Anthropic from "@anthropic-ai/sdk";
import { isConfigured } from "./claude";
import { extractSource, UnsupportedSource } from "./extract";

/**
 * Reads a file for the document library.
 *
 * The same two paths `read-file.ts` takes for a project attachment — Office
 * formats and text are unzipped locally, PDFs and images are transcribed by
 * the model — with two differences that matter for a library and not for a
 * journal:
 *
 *  - **No quiet cap.** An attachment in a thread is one record among hundreds,
 *    and its first 60,000 characters are plenty. A regulation in the library
 *    may be the only place an answer exists, so the whole text is kept, and a
 *    file that really is too long comes back marked `partial` rather than
 *    ending mid-sentence without a word said.
 *  - **A reason on failure.** The Documents page tells people why a file is
 *    not available to the AI, and "no API key" needs a different person to act
 *    than "this file has no text in it".
 */

const MODEL = "claude-opus-5";

/** Past this a text file is kept only in part — roughly eight hundred pages. */
const MAX_CHARS = 1_500_000;

export type ReadFailure =
  | "NO_KEY"
  | "UNSUPPORTED"
  | "EMPTY"
  | "REFUSED"
  | "ERROR";

export type ReadOutcome =
  | { ok: true; text: string; partial: boolean }
  | { ok: false; reason: ReadFailure };

const TRANSCRIBE =
  "You transcribe documents into plain text for a searchable library.\n\n" +
  "Write out everything the document says, in reading order: headings, " +
  "paragraphs, lists, table rows (one row per line, cells separated by " +
  "tabs), dates, names and figures. Keep the original language. Do not " +
  "translate, summarise, comment, or add anything that is not in the " +
  "document. Begin each page with a line of the form `--- Sahifa N ---`. If " +
  "a page is blank or unreadable, say so on its own line and continue.";

export async function readForKnowledge(
  bytes: Buffer,
  mime: string,
  fileName: string,
): Promise<ReadOutcome> {
  let source;
  try {
    source = extractSource(bytes, mime, fileName);
  } catch (error) {
    if (error instanceof UnsupportedSource) {
      const empty = error.message === "EMPTY" || error.message === "NO_TEXT";
      return { ok: false, reason: empty ? "EMPTY" : "UNSUPPORTED" };
    }
    return { ok: false, reason: "ERROR" };
  }

  // Office documents and plain text are already words — no model needed, and
  // so no key needed either.
  if (source.kind === "text") {
    const text = source.text.trim();
    if (!text) return { ok: false, reason: "EMPTY" };
    return {
      ok: true,
      text: text.slice(0, MAX_CHARS),
      partial: text.length > MAX_CHARS,
    };
  }

  if (!isConfigured()) return { ok: false, reason: "NO_KEY" };

  const client = new Anthropic();
  try {
    // Streamed because a long PDF is a long transcript, and a request that
    // size can outlive the HTTP timeout when it is not.
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      // Copying words off a page, not reasoning about them.
      output_config: { effort: "low" },
      system: TRANSCRIBE,
      messages: [
        {
          role: "user",
          content: [
            source.kind === "pdf"
              ? {
                  type: "document" as const,
                  source: {
                    type: "base64" as const,
                    media_type: "application/pdf" as const,
                    data: bytes.toString("base64"),
                  },
                }
              : {
                  type: "image" as const,
                  source: {
                    type: "base64" as const,
                    media_type: source.mediaType as
                      | "image/jpeg"
                      | "image/png"
                      | "image/gif"
                      | "image/webp",
                    data: bytes.toString("base64"),
                  },
                },
            { type: "text" as const, text: `File: ${fileName}` },
          ],
        },
      ],
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") return { ok: false, reason: "REFUSED" };

    const text = message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();
    if (!text) return { ok: false, reason: "EMPTY" };

    // Out of room before the end of the document: what was read is real and
    // worth keeping, but the reader has to be told the rest is missing.
    return { ok: true, text, partial: message.stop_reason === "max_tokens" };
  } catch (error) {
    console.error("[knowledge] reading failed:", error);
    return { ok: false, reason: "ERROR" };
  }
}
