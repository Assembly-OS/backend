import Anthropic from "@anthropic-ai/sdk";
import { isConfigured } from "./claude";
import {
  entryDay,
  memoryOf,
  storeFileText,
  unreadAttachments,
  type FoundEntry,
} from "@/lib/project-threads";
import { read } from "@/lib/uploads";
import { mimeForKey, readAttachment } from "./read-file";
import type { Locale } from "@/lib/types";

/**
 * The project's memory, asked a question.
 *
 * This is the one place in the platform where the model is handed **data
 * rather than tools**, and the reason is scope. `assistant.ts` answers about
 * the whole Assembly — three hundred companies will never fit in a prompt, so
 * it asks for what it needs. A thread is one counterpart's history and a
 * project is a dozen of those: bounded, small enough to read in full, and the
 * question is almost always "what do we know", which is answered by reading
 * everything rather than by guessing which record to open.
 *
 * Two rules make the answer trustworthy, and both are enforced here rather
 * than asked for in the prompt.
 *
 * **Nothing is invented.** The model is told to answer only from the records
 * and to say plainly when they do not contain the answer. `found: false` is a
 * legitimate, expected outcome — a memory that always has an answer is not a
 * memory, it is a generator.
 *
 * **Citations are checked, not trusted.** The model returns the record
 * numbers it used; every one is looked up in the set that was actually sent,
 * and anything else is dropped. A cited record that was never shown cannot
 * reach the reader, whatever the model wrote.
 */

const MODEL = "claude-opus-5";

/** A record an answer was built from. */
export interface MemorySource {
  entryId: number;
  threadId: number;
  threadTitle: string;
  day: string;
  excerpt: string;
}

export interface MemoryReply {
  answer: string;
  /** False when the records do not contain the answer. */
  found: boolean;
  sources: MemorySource[];
  /** True when the scope held more records than fitted in one request. */
  truncated: boolean;
  tokensIn: number;
  tokensOut: number;
}

/**
 * Why an answer did not come back. Kept apart because they want different
 * things from the reader: NO_KEY is for whoever administers the platform,
 * EMPTY means write something first, REFUSED is final, ERROR is worth
 * retrying.
 */
export type MemoryFailure = "NO_KEY" | "EMPTY" | "REFUSED" | "ERROR";

export type MemoryOutcome =
  | { ok: true; reply: MemoryReply }
  | { ok: false; reason: MemoryFailure };

const SCHEMA = {
  type: "object",
  properties: {
    found: {
      type: "boolean",
      description:
        "True only when the records actually contain what was asked for.",
    },
    answer: {
      type: "string",
      description:
        "The answer, drawn only from the records. When found is false, one " +
        "short sentence saying the records do not cover it — no speculation, " +
        "no general knowledge, no advice.",
    },
    used: {
      type: "array",
      items: { type: "integer" },
      description:
        "Record numbers the answer rests on. Empty when found is false.",
    },
  },
  required: ["found", "answer", "used"],
  additionalProperties: false,
} as const;

const LANGUAGE: Record<Locale, string> = {
  uz: "Uzbek (latin script)",
  uzc: "Uzbek (cyrillic script)",
  ru: "Russian",
  en: "English",
};

/**
 * Renders the records the way the model has to read them.
 *
 * The number in brackets is the citation handle, and the date is the day the
 * thing HAPPENED — not the day somebody typed it up. Getting that wrong would
 * make every "what happened in August" answer wrong for exactly the records
 * that were written late, which are the ones a person is least likely to
 * remember unaided.
 */
function render(entries: FoundEntry[], withThread: boolean): string {
  return entries
    .map((entry) => {
      const where = withThread ? ` · ${entry.thread_title}` : "";
      const head = `[${entry.id}] ${entryDay(entry)}${where} · ${entry.author_full_name}`;
      const parts = [entry.body.trim()].filter(Boolean);

      if (entry.file_name) {
        // An attached document belongs to the record that carries it, so its
        // words go in under the same number — a question about "the
        // transcript" has to be answerable, and answerable with a citation
        // pointing at the entry somebody can actually open.
        parts.push(
          entry.file_text
            ? `Attached document "${entry.file_name}":\n${entry.file_text}`
            : // Said plainly rather than left out. An unread file looks
              // exactly like an empty one to a reader who is only shown the
              // text, and "the document does not mention it" would be a lie
              // about a document nobody has read.
              `Attached document "${entry.file_name}" — not read, contents unknown.`,
        );
      }

      return `${head}\n${parts.join("\n\n") || "(no text)"}`;
    })
    .join("\n\n");
}

const RULES = `You are the memory of a project inside the Uzbekistan Economy Assembly's platform.

You are given dated records that staff wrote themselves. Answer questions about them.

Rules, in order of importance:

1. Answer ONLY from the records given. You have no other knowledge of this
   project, these organisations, or these people.
2. If the records do not contain the answer, set found=false and say so in one
   sentence. Do not guess, do not reason from what is likely, do not offer
   general advice. "The records do not say" is a correct and useful answer.
3. Cite by record number. Put every number you relied on in "used".
4. Dates matter. Each record carries the day the thing happened. When the
   question is about a period, use those days, not the order of the records.
5. Be concise and concrete. Prefer a short dated list to a paragraph when the
   question is about a sequence of events.
6. Never invent a name, a date, a figure or a commitment that is not written
   in a record.
7. Some records carry an attached document. Where its contents are given, they
   are part of that record and you may answer from them, citing the record's
   number. Where a document is marked "not read", say that the file exists but
   has not been read — never that the records contain nothing on the subject.`;

/**
 * Reads any attachment in scope that nobody has read yet, before answering.
 *
 * Files uploaded from now on are read as they land; the ones already in the
 * archive when that started were not. Left alone they would stay invisible
 * forever, and the honest answer — "a document is attached but has not been
 * read" — is a true statement that helps nobody. Somebody who asks a question
 * has said clearly enough that they want the documents read.
 *
 * Bounded to a few files per question so an ask does not become a minute of
 * silence, and each file is read once and stored, so the backlog clears
 * itself over the first questions asked and never comes back.
 *
 * Every failure is silent by design: an unreadable file simply stays unread,
 * and the answer says so.
 */
async function catchUpReading(scope: {
  projectId: number;
  threadId?: number;
}): Promise<void> {
  const pending = await unreadAttachments(scope);
  for (const attachment of pending) {
    const mime = mimeForKey(attachment.file_key);
    if (!mime) continue;
    const bytes = read(attachment.file_key);
    if (!bytes) continue;
    const text = await readAttachment(bytes, mime, attachment.file_name);
    if (text) await storeFileText(attachment.id, text);
  }
}

export async function askMemory(
  scope: { projectId: number; threadId?: number },
  question: string,
  locale: Locale,
): Promise<MemoryOutcome> {
  // Before anything else, including the key check. Word, Excel, text and CSV
  // are read locally and need no model at all, so an organisation without an
  // API key still gets its documents into the search index — only the answer
  // is unavailable to it, not the reading.
  //
  // Ordering matters twice over: the catch-up writes the text that `memoryOf`
  // is about to select.
  await catchUpReading(scope);

  if (!isConfigured()) return { ok: false, reason: "NO_KEY" };

  const { entries, truncated } = await memoryOf(scope);
  if (entries.length === 0) return { ok: false, reason: "EMPTY" };

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const client = new Anthropic();

  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: {
        // Retrieval over text that is already in the prompt: the reasoning is
        // reading and quoting, not deduction, and `medium` does it as well as
        // `high` for materially less per question — this runs on every ask.
        effort: "medium",
        format: { type: "json_schema", schema: SCHEMA },
      },
      system: `${RULES}\n\nAnswer in ${LANGUAGE[locale] ?? LANGUAGE.uz}.`,
      messages: [
        {
          role: "user",
          content:
            `Records${truncated ? " (most recent only — older ones were not included)" : ""}:\n\n` +
            `${render(entries, !scope.threadId)}\n\n---\n\nQuestion: ${question}`,
        },
      ],
    });

    if (response.stop_reason === "refusal")
      return { ok: false, reason: "REFUSED" };

    const text = response.content.find((block) => block.type === "text");
    if (!text || text.type !== "text") return { ok: false, reason: "ERROR" };

    const parsed = JSON.parse(text.text) as {
      found: boolean;
      answer: string;
      used: number[];
    };

    // Citations are verified against what was actually sent. A record the
    // model names but was never shown does not reach the reader.
    const sources: MemorySource[] = (parsed.used ?? [])
      .map((id) => byId.get(id))
      .filter((entry): entry is FoundEntry => Boolean(entry))
      .map((entry) => ({
        entryId: entry.id,
        threadId: entry.thread_id,
        threadTitle: entry.thread_title,
        day: entryDay(entry),
        excerpt: entry.body.slice(0, 160),
      }));

    return {
      ok: true,
      reply: {
        answer: parsed.answer,
        found: Boolean(parsed.found),
        sources,
        truncated,
        tokensIn: response.usage.input_tokens,
        tokensOut: response.usage.output_tokens,
      },
    };
  } catch {
    return { ok: false, reason: "ERROR" };
  }
}
