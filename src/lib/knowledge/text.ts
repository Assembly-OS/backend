import { createHash } from "node:crypto";

/**
 * The text side of the memory: cutting, hashing, matching and ranking.
 *
 * Nothing in this file touches the database or the network, on purpose. It
 * is what the unit tests load, and it is where the decisions that shape
 * retrieval live — how long a passage is, what counts as a search term, how
 * two rankings are combined — so they can be read in one place and checked
 * without a server.
 */

/* ------------------------------------------------------------------ */
/* Kinds and trust                                                     */
/* ------------------------------------------------------------------ */

/** Every kind of record the memory reads. The string is stored as is. */
export const SOURCE_KINDS = [
  "task",
  "meeting",
  "thread_entry",
  "message",
  "project_document",
  "library",
  "kelishuv",
  "agreement",
  "project",
  "uyushma",
  "partner",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export function isSourceKind(value: unknown): value is SourceKind {
  return typeof value === "string" && (SOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * How far to trust a kind when sources disagree.
 *
 * A task's own record is what the platform enforces — status, holder and
 * deadline are facts, not reports of facts — so it outranks a meeting's
 * conclusion, which outranks what a transcript seems to say, which outranks
 * a line in a chat. The assistant is told these numbers and told to prefer
 * the higher one when two sources conflict, and to say that they conflict.
 */
export const RELIABILITY: Record<SourceKind, number> = {
  task: 1,
  project: 0.95,
  uyushma: 0.95,
  partner: 0.9,
  kelishuv: 0.95,
  agreement: 0.9,
  meeting: 0.85,
  project_document: 0.85,
  library: 0.8,
  thread_entry: 0.75,
  message: 0.6,
};

/* ------------------------------------------------------------------ */
/* Cutting text into passages                                          */
/* ------------------------------------------------------------------ */

/** About a page: enough context to answer from, small enough to cite. */
export const CHUNK_TARGET = 1_400;
/** A single paragraph longer than this is split at a sentence or a space. */
export const CHUNK_MAX = 2_600;
/** Words carried over from the end of one passage to the start of the next. */
const OVERLAP = 160;

export interface Chunk {
  position: number;
  section: string | null;
  body: string;
}

/** A line that reads as a heading: a page/sheet/slide marker, or a short
 *  line ending without punctuation, in caps or numbered like "2.1". */
function headingOf(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (/^--- .+ ---$/.test(trimmed)) return trimmed.replace(/^--- | ---$/g, "");
  if (trimmed.length > 80) return null;
  if (/[.!?:;,]$/.test(trimmed)) return null;
  if (/^(\d+(\.\d+)*\.?|[IVX]+\.)\s+\S/.test(trimmed)) return trimmed;
  const letters = trimmed.replace(/[^\p{L}]/gu, "");
  if (letters.length >= 4 && letters === letters.toUpperCase()) return trimmed;
  return null;
}

function splitLong(paragraph: string): string[] {
  const out: string[] = [];
  let rest = paragraph;
  while (rest.length > CHUNK_MAX) {
    // Prefer a sentence end, then a space, inside the back half of the window.
    const window = rest.slice(0, CHUNK_MAX);
    const sentence = Math.max(
      window.lastIndexOf(". "),
      window.lastIndexOf("! "),
      window.lastIndexOf("? "),
      window.lastIndexOf("\n"),
    );
    const space = window.lastIndexOf(" ");
    const cut =
      sentence > CHUNK_MAX / 2 ? sentence + 1 : space > CHUNK_MAX / 2 ? space : CHUNK_MAX;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Cuts a text into passages of about a page, along paragraph breaks,
 * starting a new one at a heading, with a short overlap so a sentence that
 * straddles the cut is findable from either side.
 *
 * The section label is the last heading seen, which is what makes "part 14
 * of the master plan" readable as "3.2 Financing" in a citation.
 */
export function chunkText(text: string): Chunk[] {
  const normalised = text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (!normalised) return [];

  const chunks: Chunk[] = [];
  let section: string | null = null;
  let current = "";
  let currentSection: string | null = null;
  let tail = "";

  const flush = () => {
    const body = current.trim();
    if (body) {
      chunks.push({ position: chunks.length + 1, section: currentSection, body });
      // The overlap: the last few words, prefixed to the next passage.
      const words = body.split(/\s+/);
      tail = words.slice(Math.max(0, words.length - 24)).join(" ");
      if (tail.length > OVERLAP) tail = tail.slice(-OVERLAP);
    }
    current = "";
  };

  for (const rawParagraph of normalised.split(/\n{2,}|\n(?=\s*(?:--- |[-•*] |\d+[.)] ))/)) {
    const paragraph = rawParagraph.trim();
    if (!paragraph) continue;

    const heading = headingOf(paragraph.split("\n")[0]);
    if (heading && current.length > CHUNK_TARGET / 3) flush();
    if (heading) section = heading;

    for (const piece of splitLong(paragraph)) {
      // A passage that is only a heading or a line is not worth a citation
      // of its own: let a short one grow past the target rather than flush.
      if (current && current.length > 200 && current.length + piece.length + 1 > CHUNK_TARGET)
        flush();
      if (!current) {
        currentSection = section;
        // Only carry an overlap into a passage that continues the same text.
        current = tail && chunks.length > 0 ? `${tail}\n${piece}` : piece;
      } else {
        current += `\n${piece}`;
      }
    }
  }
  flush();
  return chunks;
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

/**
 * Words a search is made of, each matched as a prefix.
 *
 * Uzbek and Russian both inflect heavily: a record says "moliyalashtirish"
 * where the question says "moliya", "договора" where it says "договоры". A
 * prefix covers the first; the second needs the ending gone, so words of
 * seven letters or more lose their last two. A crude stem, and a deliberate
 * one — it errs towards finding too much, and ranking sorts that out.
 *
 * Words under three letters are dropped unless they are numbers: as
 * prefixes, "по", "va" or "the" match nearly every passage there is.
 */
export function searchTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words)]
    .filter((word) => word.length >= 3 || /^\d+$/.test(word))
    .slice(0, 12)
    .map((word) => (word.length >= 7 ? word.slice(0, -2) : word));
}

/** `to_tsquery('simple', …)` input: every term as a prefix, any of them. */
export function tsQuery(terms: string[]): string {
  return terms.map((term) => `${term.replace(/[^\p{L}\p{N}]/gu, "")}:*`).join(" | ");
}

/** The first window of a passage that contains a search term, for a listing. */
export function excerpt(body: string, terms: string[], max = 240): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const lower = flat.toLowerCase();
  let at = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  if (at < 0) return `${flat.slice(0, max - 1).trimEnd()}…`;
  const start = Math.max(0, at - Math.floor(max / 3));
  const end = Math.min(flat.length, start + max);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/**
 * A stable hash of what was read, so a record re-ingested unchanged costs
 * nothing: same fingerprint, same version, nothing rewritten.
 */
export function fingerprint(parts: (string | number | null | undefined)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part ?? ""}\u0000`);
  return hash.digest("hex");
}

/* ------------------------------------------------------------------ */
/* Ranking                                                             */
/* ------------------------------------------------------------------ */

export interface Ranked {
  id: number;
  score: number;
}

/**
 * Reciprocal-rank fusion of several rankings of the same ids.
 *
 * Word matching and meaning matching rank on scales that have nothing to do
 * with each other, so their scores cannot be added. Their *ranks* can: an id
 * that is third in one list and fifth in the other beats one that is first
 * in one and absent from the other. `k` damps the top ranks so a single
 * list cannot dominate.
 */
export function fuseRanks(lists: Ranked[][], k = 60): Map<number, number> {
  const fused = new Map<number, number>();
  for (const list of lists) {
    const sorted = [...list].sort((a, b) => b.score - a.score);
    sorted.forEach((item, index) => {
      fused.set(item.id, (fused.get(item.id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return fused;
}

/**
 * 1 for something that happened today, falling to about 0.5 after a year
 * and never below 0.2: recent records are preferred, old ones are not
 * forgotten. Undated records sit in the middle.
 */
export function freshness(occurredAt: string | null, now = new Date()): number {
  if (!occurredAt) return 0.6;
  const when = Date.parse(occurredAt.replace(" ", "T") + (occurredAt.length <= 10 ? "T00:00:00Z" : "Z"));
  if (!Number.isFinite(when)) return 0.6;
  const days = Math.max(0, (now.getTime() - when) / 86_400_000);
  return Math.max(0.2, 1 / (1 + days / 365));
}

/**
 * The final order: fused rank, weighted by how far the source is trusted
 * and how recent it is. Both weights are gentle — a strong match in a chat
 * line still beats a weak one in a task record.
 */
export function finalScore(
  fused: number,
  reliability: number,
  occurredAt: string | null,
  now = new Date(),
): number {
  return fused * (0.6 + 0.4 * reliability) * (0.7 + 0.3 * freshness(occurredAt, now));
}

/* ------------------------------------------------------------------ */
/* Handing text to the model                                           */
/* ------------------------------------------------------------------ */

/**
 * Wraps a record's text as data for the model.
 *
 * Everything the memory holds was written by somebody — a colleague, a
 * counterpart, whoever sent a PDF — and none of it is an instruction to the
 * assistant. The wrapper says so, and the model is told in its rules that
 * text inside these tags is to be read, quoted and cited, never obeyed.
 */
export function asDocument(label: string, text: string): string {
  const safeLabel = label.replace(/[<>"]/g, "");
  const safeText = text.replace(/<\/?(document|instructions?|system)[^>]*>/gi, "");
  return `<document source="${safeLabel}">\n${safeText}\n</document>`;
}

/** Rough token estimate for budgeting a prompt: ~4 characters a token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
