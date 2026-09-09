import Anthropic from "@anthropic-ai/sdk";
import { isConfigured } from "./claude";
import { extractSource, UnsupportedSource } from "./extract";

/**
 * Turns an attached file into words the project's memory can read.
 *
 * A document that is only a filename is not in the memory at all. Somebody
 * uploads a meeting transcript, asks a month later what was agreed, and gets
 * "the records contain no transcript" — which is true, and useless. The file
 * has to be read once, at the moment it arrives, and stored as text.
 *
 * Two paths, and the cheap one is tried first:
 *
 *  - **Word, Excel, PowerPoint, plain text, CSV, JSON** are unzipped and read
 *    locally by `extract.ts`. No model call, no cost, no network.
 *  - **PDFs and images** have no text to unzip — a scan has no characters at
 *    all — so they go to the model once and come back as plain text.
 *
 * Failure is never fatal. The entry is already saved by the time this runs;
 * an unreadable file simply leaves `file_text` null, and the assistant says
 * the document has not been read rather than pretending it was empty.
 */

const MODEL = "claude-opus-5";

/** Past this, a document is not read: the cost stops being worth the answer. */
const MAX_BYTES = 12 * 1024 * 1024;

/** Enough for a long transcript; a book was never going to fit anyway. */
const MAX_CHARS = 60_000;

export async function readAttachment(
  bytes: Buffer,
  mime: string,
  fileName: string,
): Promise<string | null> {
  if (bytes.byteLength > MAX_BYTES) return null;

  let source;
  try {
    source = extractSource(bytes, mime, fileName);
  } catch (error) {
    // A format nothing can read is a normal outcome, not an incident.
    if (error instanceof UnsupportedSource) return null;
    return null;
  }

  // Office documents and plain text are already words — no model needed.
  if (source.kind === "text") {
    const text = source.text.trim();
    return text ? text.slice(0, MAX_CHARS) : null;
  }

  if (!isConfigured()) return null;

  const client = new Anthropic();
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: {
        // Transcription, not reasoning: the words are on the page and the job
        // is to copy them out. This runs on every upload, so it pays to be
        // the cheapest setting that reads a page correctly.
        effort: "low",
      },
      system:
        "You transcribe documents into plain text so they can be searched and " +
        "quoted later.\n\n" +
        "Write out everything the document says, in reading order: headings, " +
        "paragraphs, table rows, dates, names, figures. Keep the original " +
        "language — do not translate. Do not summarise, do not comment, do " +
        "not add anything that is not in the document. If a page is blank or " +
        "unreadable, say so on its own line and continue.",
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

    if (response.stop_reason === "refusal") return null;
    const block = response.content.find((part) => part.type === "text");
    if (!block || block.type !== "text") return null;
    const text = block.text.trim();
    return text ? text.slice(0, MAX_CHARS) : null;
  } catch {
    return null;
  }
}
