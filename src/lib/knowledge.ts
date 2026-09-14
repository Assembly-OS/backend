import { canSubmitToAi } from "./agents/access";
import { readForKnowledge, type ReadFailure } from "./agents/read-knowledge";
import { all, get, now, run } from "./pg";
import type { User } from "./types";
import { read } from "./uploads";

/**
 * The document library — the files the AI assistant answers from.
 *
 * One library for the whole Assembly. Everyone can see what is in it, because
 * knowing what the assistant knows is how a person decides whether to trust
 * an answer. Adding, replacing and removing files is for the people who may
 * already hand material to the AI agents.
 *
 * A file is read once, after the upload has been answered, and cut into
 * passages the assistant searches. Nothing here asks the model what a
 * document means; it only makes the words findable. The assistant does the
 * reading, and cites what it read.
 */

export type KnowledgeStatus = "READING" | "READY" | "PARTIAL" | "FAILED";

export type KnowledgeReason = ReadFailure | "TOO_LONG" | "INTERRUPTED";

export interface KnowledgeDocument {
  id: number;
  title: string;
  file_key: string;
  file_name: string;
  file_size: number;
  file_mime: string;
  format: string;
  status: KnowledgeStatus;
  reason: KnowledgeReason | null;
  text_chars: number;
  part_count: number;
  version: number;
  uploaded_by: number;
  uploader_name: string;
  read_at: string | null;
  created_at: string;
  updated_at: string;
}

export function canManageKnowledge(user: User): boolean {
  return canSubmitToAi(user);
}

/** Whether the assistant can use a document's words at all. */
export function isAvailable(status: KnowledgeStatus): boolean {
  return status === "READY" || status === "PARTIAL";
}

const DOCUMENT_SELECT = `
  SELECT d.*, u.full_name AS uploader_name
    FROM knowledge_documents d
    JOIN users u ON u.id = d.uploaded_by
`;

/**
 * A read runs in the server process after the upload is answered, so a
 * restart in the middle of one leaves the row saying READING forever. Nothing
 * takes half an hour to read; anything still reading after that was cut off,
 * and saying so is what lets somebody press "read again".
 */
const INTERRUPTED_AFTER_MS = 30 * 60_000;

async function closeInterruptedReads(): Promise<void> {
  const cutoff = new Date(Date.now() - INTERRUPTED_AFTER_MS)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  await run(
    `UPDATE knowledge_documents SET status = 'FAILED', reason = 'INTERRUPTED'
      WHERE status = 'READING' AND updated_at < ?`,
    cutoff,
  );
}

export async function listDocuments(): Promise<KnowledgeDocument[]> {
  await closeInterruptedReads();
  return await all<KnowledgeDocument>(
    `${DOCUMENT_SELECT} ORDER BY d.updated_at DESC, d.id DESC`,
  );
}

export async function documentById(
  id: number,
): Promise<KnowledgeDocument | undefined> {
  await closeInterruptedReads();
  return await get<KnowledgeDocument>(`${DOCUMENT_SELECT} WHERE d.id = ?`, id);
}

/* ------------------------------------------------------------------ */
/* Changing the library                                                */
/* ------------------------------------------------------------------ */

export interface StoredFile {
  key: string;
  name: string;
  size: number;
  mime: string;
  format: string;
}

export async function createDocument(
  file: StoredFile,
  title: string,
  userId: number,
): Promise<{ id: number; version: number }> {
  const stamp = now();
  const row = await get<{ id: number; version: number }>(
    `INSERT INTO knowledge_documents
       (title, file_key, file_name, file_size, file_mime, format, uploaded_by,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id, version`,
    title,
    file.key,
    file.name,
    file.size,
    file.mime,
    file.format,
    userId,
    stamp,
    stamp,
  );
  if (!row) throw new Error("knowledge document was not created");
  return row;
}

/**
 * Puts a new file in place of an old one, under the same document.
 *
 * The old passages go at once rather than when the new file has been read:
 * for the minute in between, "not read yet" is true, and answering from a
 * version somebody just replaced would not be.
 */
export async function replaceFile(
  id: number,
  file: StoredFile,
  title: string | null,
): Promise<{ previousKey: string; version: number } | null> {
  const before = await get<{ file_key: string }>(
    "SELECT file_key FROM knowledge_documents WHERE id = ?",
    id,
  );
  if (!before) return null;

  const row = await get<{ version: number }>(
    `UPDATE knowledge_documents
        SET file_key = ?, file_name = ?, file_size = ?, file_mime = ?, format = ?,
            title = COALESCE(?, title),
            status = 'READING', reason = NULL, text_chars = 0, part_count = 0,
            read_at = NULL, version = version + 1, updated_at = ?
      WHERE id = ?
      RETURNING version`,
    file.key,
    file.name,
    file.size,
    file.mime,
    file.format,
    title,
    now(),
    id,
  );
  if (!row) return null;

  await run(
    "DELETE FROM knowledge_parts WHERE document_id = ? AND version < ?",
    id,
    row.version,
  );
  return { previousKey: before.file_key, version: row.version };
}

/** Removes a document and its passages. Returns the storage key to delete. */
export async function removeDocument(id: number): Promise<string | null> {
  const row = await get<{ file_key: string }>(
    "DELETE FROM knowledge_documents WHERE id = ? RETURNING file_key",
    id,
  );
  return row?.file_key ?? null;
}

/**
 * Sets a document back to READING so it can be read again. Refuses one that
 * is already being read: two reads of the same version would write the same
 * passages twice.
 */
export async function markReading(id: number): Promise<number | null> {
  const row = await get<{ version: number }>(
    `UPDATE knowledge_documents
        SET status = 'READING', reason = NULL, updated_at = ?
      WHERE id = ? AND status <> 'READING'
      RETURNING version`,
    now(),
    id,
  );
  return row?.version ?? null;
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/** About a page of text: enough context to answer from, small enough to cite. */
const PART_TARGET = 1_500;
const PART_MAX = 3_000;

/**
 * Cuts text into passages along line breaks, starting a new one at a page,
 * sheet or slide marker when the current passage already has some substance.
 * A single line longer than a passage is split at a space.
 */
export function splitIntoParts(text: string): string[] {
  const parts: string[] = [];
  let current = "";

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) parts.push(trimmed);
    current = "";
  };

  for (const raw of text.split(/\r?\n/)) {
    let line = raw;

    if (line.startsWith("--- ") && current.length > PART_TARGET / 3) flush();

    while (line.length > PART_MAX) {
      flush();
      const space = line.lastIndexOf(" ", PART_MAX);
      const cut = space > PART_MAX / 2 ? space : PART_MAX;
      parts.push(line.slice(0, cut).trim());
      line = line.slice(cut);
    }

    if (current && current.length + line.length + 1 > PART_TARGET) flush();
    current += current ? `\n${line}` : line;
  }
  flush();

  return parts;
}

/**
 * Reads one version of a document into passages. Runs after the upload has
 * been answered, so it reports through the row, never by throwing.
 *
 * Every write names the version it read. If the file was replaced while this
 * was running, the status update matches nothing and the passages it wrote
 * carry a version nobody searches; the read of the new file deletes them.
 */
export async function readDocument(id: number, version: number): Promise<void> {
  try {
    const document = await get<{
      file_key: string;
      file_mime: string;
      file_name: string;
      version: number;
    }>(
      "SELECT file_key, file_mime, file_name, version FROM knowledge_documents WHERE id = ?",
      id,
    );
    if (!document || document.version !== version) return;

    const bytes = read(document.file_key);
    const outcome = bytes
      ? await readForKnowledge(bytes, document.file_mime, document.file_name)
      : ({ ok: false, reason: "ERROR" } as const);

    if (!outcome.ok) {
      await run(
        `UPDATE knowledge_documents SET status = 'FAILED', reason = ?, updated_at = ?
          WHERE id = ? AND version = ?`,
        outcome.reason,
        now(),
        id,
        version,
      );
      return;
    }

    const parts = splitIntoParts(outcome.text);
    await run(
      "DELETE FROM knowledge_parts WHERE document_id = ? AND version <= ?",
      id,
      version,
    );
    for (let start = 0; start < parts.length; start += 100) {
      const batch = parts.slice(start, start + 100);
      await run(
        `INSERT INTO knowledge_parts (document_id, version, position, body)
         VALUES ${batch.map(() => "(?, ?, ?, ?)").join(", ")}`,
        ...batch.flatMap((body, index) => [id, version, start + index + 1, body]),
      );
    }

    const stamp = now();
    await run(
      `UPDATE knowledge_documents
          SET status = ?, reason = ?, text_chars = ?, part_count = ?,
              read_at = ?, updated_at = ?
        WHERE id = ? AND version = ?`,
      outcome.partial ? "PARTIAL" : "READY",
      outcome.partial ? "TOO_LONG" : null,
      outcome.text.length,
      parts.length,
      stamp,
      stamp,
      id,
      version,
    );
  } catch (error) {
    console.error("[knowledge] indexing failed:", error);
    await run(
      `UPDATE knowledge_documents SET status = 'FAILED', reason = 'ERROR', updated_at = ?
        WHERE id = ? AND version = ?`,
      now(),
      id,
      version,
    ).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* What the assistant and the page read                                */
/* ------------------------------------------------------------------ */

export interface CatalogEntry {
  id: number;
  title: string;
  file_name: string;
  format: string;
  status: KnowledgeStatus;
  reason: KnowledgeReason | null;
  parts: number;
  updated_at: string;
}

/** Every document with its status — the assistant's table of contents. */
export async function knowledgeCatalog(): Promise<CatalogEntry[]> {
  return await all<CatalogEntry>(
    `SELECT id, title, file_name, format, status, reason,
            part_count AS parts, updated_at
       FROM knowledge_documents
      ORDER BY title`,
  );
}

export interface KnowledgeHit {
  document_id: number;
  title: string;
  position: number;
  part_count: number;
  body: string;
}

/**
 * Words a search is made of, each matched as a prefix.
 *
 * Uzbek and Russian both inflect heavily, and a document says
 * "moliyalashtirish" where the question says "moliya", or "договора" where it
 * says "договоры". A prefix covers the first; the second needs the ending
 * gone, so words of seven letters or more lose their last two. That is a
 * crude stem and a deliberate one: it errs towards finding too much, and the
 * ranking puts the passages with the most matching words first.
 *
 * Words under three letters are dropped unless they are numbers. As prefixes,
 * "по", "за" or "va" match nearly every passage in the library, so a question
 * the documents cannot answer would still come back full of hits.
 */
export function searchTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words)]
    .filter((word) => word.length >= 3 || /^\d+$/.test(word))
    .slice(0, 12)
    .map((word) => (word.length >= 7 ? word.slice(0, -2) : word));
}

export async function searchKnowledge(
  query: string,
  limit = 8,
): Promise<KnowledgeHit[]> {
  const terms = searchTerms(query);
  if (terms.length === 0) return [];

  return await all<KnowledgeHit>(
    `SELECT p.document_id, d.title, p.position, d.part_count, p.body
       FROM knowledge_parts p
       JOIN knowledge_documents d ON d.id = p.document_id AND d.version = p.version
      CROSS JOIN to_tsquery('simple', ?) q
      WHERE d.status IN ('READY', 'PARTIAL') AND p.search @@ q
      ORDER BY ts_rank(p.search, q) DESC, p.document_id, p.position
      LIMIT ?`,
    terms.map((term) => `${term}:*`).join(" | "),
    limit,
  );
}

/**
 * A document's passages in order, from a given one, as many as fit.
 *
 * `nextPart` is how the caller continues rather than being handed a cut-off
 * text and left to believe that is where the document ends.
 */
export async function documentText(
  id: number,
  { from = 1, maxChars = 30_000, maxParts = 80 } = {},
): Promise<{
  document: KnowledgeDocument;
  parts: { position: number; body: string }[];
  nextPart: number | null;
} | null> {
  const document = await documentById(id);
  if (!document) return null;

  const rows = await all<{ position: number; body: string }>(
    `SELECT position, body FROM knowledge_parts
      WHERE document_id = ? AND version = ? AND position >= ?
      ORDER BY position
      LIMIT ?`,
    id,
    document.version,
    Math.max(1, from),
    maxParts,
  );

  const parts: { position: number; body: string }[] = [];
  let used = 0;
  for (const row of rows) {
    if (parts.length > 0 && used + row.body.length > maxChars) break;
    parts.push(row);
    used += row.body.length;
  }

  const last = parts.at(-1)?.position ?? Math.max(1, from) - 1;
  return {
    document,
    parts,
    nextPart: last < document.part_count ? last + 1 : null,
  };
}
