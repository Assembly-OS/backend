import { isConfigured } from "../agents/claude";
import { all, get, now, run, tx } from "../pg";
import { collect, type DerivedFact } from "./collect";
import { embeddingProvider, vectorLiteral } from "./embeddings";
import { extractFacts, matchTask, resolvePerson } from "./facts";
import { enqueueJob, type Job } from "./jobs";
import { retire } from "./sources";
import { chunkText, fingerprint, type SourceKind } from "./text";
import type { SourceRow } from "./types";

/**
 * What a worker does with a job.
 *
 *  index — open the record, render it, compare the fingerprint; when it
 *          changed, write a new version of its passages and queue the two
 *          passes below. Unchanged records cost one hash.
 *  embed — ask the provider for vectors for the passages that have none.
 *  facts — ask the model what the record states; link action items to tasks.
 *
 * Versions are the idempotency: passages carry the version they were cut
 * from, only the current version is searched, and an older read that
 * finishes late writes rows nobody reads and the next index deletes.
 */

/** Kinds whose facts come from the model; the rest state theirs in fields. */
const MODEL_FACT_KINDS: SourceKind[] = [
  "meeting",
  "thread_entry",
  "message",
  "project_document",
  "library",
  "kelishuv",
];
/** Below this many characters a model pass is not worth the call. */
const MIN_FACT_CHARS = 240;

export async function processJob(job: Job): Promise<void> {
  const source = await get<SourceRow>("SELECT * FROM knowledge_sources WHERE id = ?", job.source_id);
  if (!source) return;
  if (source.status === "DELETED" && job.kind !== "index") return;

  switch (job.kind) {
    case "index":
      return indexSource(source);
    case "embed":
      return embedSource(source);
    case "facts":
      return factsForSource(source);
    case "reconcile":
      return reconcile(source);
  }
}

/* ------------------------------------------------------------------ */
/* index                                                               */
/* ------------------------------------------------------------------ */

async function indexSource(source: SourceRow): Promise<void> {
  await run(
    "UPDATE knowledge_sources SET status = CASE WHEN status IN ('READY','PARTIAL') THEN status ELSE 'PROCESSING' END, updated_at = ? WHERE id = ?",
    now(),
    source.id,
  );

  const collected = await collect(source.kind, source.ref_id);
  if (!collected) {
    await retire(source.id, "GONE");
    return;
  }

  const scope = collected.scope;
  const print = fingerprint([
    collected.title,
    collected.text,
    collected.occurredAt,
    collected.skip ?? "",
    collected.reason ?? "",
    scope.projectId,
    scope.threadId,
    scope.taskId,
  ]);

  const stamp = now();
  const scopeSets = `title = ?, author_id = ?, occurred_at = ?, lang = ?, reliability = ?,
      project_id = ?, company_id = ?, meeting_id = ?, task_id = ?, thread_id = ?, group_id = ?,
      from_user_id = ?, to_user_id = ?, uyushma_id = ?`;
  const scopeValues = [
    collected.title.slice(0, 300),
    collected.authorId,
    collected.occurredAt,
    collected.lang,
    collected.reliability,
    scope.projectId ?? null,
    scope.companyId ?? null,
    scope.meetingId ?? null,
    scope.taskId ?? null,
    scope.threadId ?? null,
    scope.groupId ?? null,
    scope.fromUserId ?? null,
    scope.toUserId ?? null,
    scope.uyushmaId ?? null,
  ];

  // Nothing to index: the record exists, and that is all the memory keeps.
  if (collected.skip) {
    await run("DELETE FROM knowledge_chunks WHERE source_id = ?", source.id);
    await run("DELETE FROM knowledge_facts WHERE source_id = ?", source.id);
    await run(
      `UPDATE knowledge_sources SET ${scopeSets}, status = ?, reason = ?, fingerprint = ?,
              text_chars = 0, chunk_count = 0, indexed_at = ?, updated_at = ? WHERE id = ?`,
      ...scopeValues,
      // A transcription or a read that failed is a failure to retry; a
      // record with nothing in it is simply skipped.
      collected.partial ? "FAILED" : "SKIPPED",
      collected.skip,
      print,
      stamp,
      stamp,
      source.id,
    );
    if (collected.partial) throw new Error(`could not read: ${collected.skip}`);
    return;
  }

  // Unchanged since the last read: refresh the stamp and finish whatever
  // passes were still owed (a key configured since, say).
  if (print === source.fingerprint && source.chunk_count > 0 && source.status !== "DELETED") {
    await run(
      `UPDATE knowledge_sources SET ${scopeSets}, indexed_at = ?, updated_at = ? WHERE id = ?`,
      ...scopeValues,
      stamp,
      stamp,
      source.id,
    );
    await queueFollowUps(source, collected.text.length, collected.facts);
    return;
  }

  const chunks = chunkText(collected.text);
  const version = source.version + 1;

  await tx(async (q) => {
    for (let start = 0; start < chunks.length; start += 100) {
      const batch = chunks.slice(start, start + 100);
      await q.run(
        `INSERT INTO knowledge_chunks (source_id, version, position, section, body)
         VALUES ${batch.map(() => "(?, ?, ?, ?, ?)").join(", ")}`,
        ...batch.flatMap((chunk) => [source.id, version, chunk.position, chunk.section, chunk.body]),
      );
    }
    // The old version goes only once the new one is in: between the two
    // there is never a moment with no passages to answer from.
    await q.run("DELETE FROM knowledge_chunks WHERE source_id = ? AND version < ?", source.id, version);
    await q.run("DELETE FROM knowledge_facts WHERE source_id = ? AND version < ?", source.id, version);
    await q.run("DELETE FROM knowledge_links WHERE source_id = ?", source.id);
    for (const link of collected.links) {
      await q.run(
        `INSERT INTO knowledge_links (source_id, to_kind, to_id, relation)
         VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        source.id,
        link.toKind,
        link.toId,
        link.relation,
      );
    }
    await q.run(
      `UPDATE knowledge_sources SET ${scopeSets}, version = ?, fingerprint = ?, status = ?, reason = ?,
              text_chars = ?, chunk_count = ?, indexed_at = ?, embedded_at = NULL, facts_at = NULL,
              updated_at = ?
        WHERE id = ?`,
      ...scopeValues,
      version,
      print,
      collected.partial ? "PARTIAL" : "READY",
      collected.partial ? (collected.reason ?? null) : null,
      collected.text.length,
      chunks.length,
      stamp,
      stamp,
      source.id,
    );
  });

  // Facts the record states in its own fields need no model: written now.
  if (collected.facts?.length) await writeDerivedFacts(source.id, version, collected.facts, scope.projectId ?? null);

  await queueFollowUps({ ...source, version, embedded_at: null, facts_at: null }, collected.text.length, collected.facts);
}

async function queueFollowUps(
  source: SourceRow,
  chars: number,
  derived: DerivedFact[] | undefined,
): Promise<void> {
  if (!source.embedded_at && embeddingProvider()) await enqueueJob(source.id, "embed");
  const wantsModel =
    MODEL_FACT_KINDS.includes(source.kind) && chars >= MIN_FACT_CHARS && isConfigured();
  if (!source.facts_at && wantsModel) await enqueueJob(source.id, "facts");
  else if (!source.facts_at && !wantsModel && derived !== undefined)
    // No model pass owed: the derived facts (if any) are the facts.
    await run("UPDATE knowledge_sources SET facts_at = ? WHERE id = ?", now(), source.id);
}

async function writeDerivedFacts(
  sourceId: number,
  version: number,
  facts: DerivedFact[],
  projectId: number | null,
): Promise<void> {
  for (const fact of facts) {
    const whoUserId = fact.whoUserId ?? (await resolvePerson(fact.who));
    const taskId =
      fact.taskId ??
      (fact.kind === "action_item" || fact.kind === "commitment"
        ? await matchTask(fact.statement, { projectId, whoUserId })
        : null);
    await run(
      `INSERT INTO knowledge_facts
         (source_id, version, kind, subject, statement, who, who_user_id, due_on, stated,
          confidence, quote, task_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'direct', 1, NULL, ?, 'confirmed', ?)`,
      sourceId,
      version,
      fact.kind,
      fact.subject,
      fact.statement.slice(0, 1000),
      fact.who,
      whoUserId,
      fact.dueOn,
      taskId,
      now(),
    );
  }
}

/* ------------------------------------------------------------------ */
/* embed                                                               */
/* ------------------------------------------------------------------ */

async function embedSource(source: SourceRow): Promise<void> {
  const provider = embeddingProvider();
  if (!provider) return;
  const chunks = await all<{ id: number; body: string; section: string | null }>(
    `SELECT id, body, section FROM knowledge_chunks
      WHERE source_id = ? AND version = ? AND (embedding IS NULL OR embedding_model <> ?)
      ORDER BY position`,
    source.id,
    source.version,
    provider.model,
  );
  if (chunks.length > 0) {
    // The title and section go in with the words: "3.2 Financing" is half
    // of what a passage about financing means.
    const vectors = await provider.embed(
      chunks.map((chunk) => `${source.title}${chunk.section ? ` — ${chunk.section}` : ""}\n${chunk.body}`),
      "document",
    );
    for (const [index, chunk] of chunks.entries()) {
      await run(
        "UPDATE knowledge_chunks SET embedding = ?::real[], embedding_model = ? WHERE id = ?",
        vectorLiteral(vectors[index]),
        provider.model,
        chunk.id,
      );
    }
  }
  await run("UPDATE knowledge_sources SET embedded_at = ?, updated_at = ? WHERE id = ?", now(), now(), source.id);
}

/* ------------------------------------------------------------------ */
/* facts                                                               */
/* ------------------------------------------------------------------ */

async function factsForSource(source: SourceRow): Promise<void> {
  const chunks = await all<{ id: number; position: number; body: string }>(
    "SELECT id, position, body FROM knowledge_chunks WHERE source_id = ? AND version = ? ORDER BY position",
    source.id,
    source.version,
  );
  const outcome = await extractFacts(chunks, {
    title: source.title,
    kind: source.kind,
    occurredAt: source.occurred_at,
  });

  const byPosition = new Map(chunks.map((chunk) => [chunk.position, chunk.id]));
  await tx(async (q) => {
    // Model facts replace the previous model facts of this version; the
    // derived ones (confidence 1, no quote) stay.
    await q.run(
      "DELETE FROM knowledge_facts WHERE source_id = ? AND version = ? AND quote IS NOT NULL",
      source.id,
      source.version,
    );
    for (const fact of outcome.facts) {
      const whoUserId = await resolvePerson(fact.who);
      const taskId =
        fact.kind === "action_item" || fact.kind === "commitment"
          ? await matchTask(fact.statement, { projectId: source.project_id, whoUserId })
          : null;
      await q.run(
        `INSERT INTO knowledge_facts
           (source_id, version, chunk_id, kind, subject, statement, who, who_user_id, due_on,
            stated, confidence, quote, task_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
        source.id,
        source.version,
        byPosition.get(fact.passage) ?? null,
        fact.kind,
        fact.subject,
        fact.statement,
        fact.who,
        whoUserId,
        fact.dueOn,
        fact.stated,
        fact.confidence,
        fact.quote ?? "",
        taskId,
        now(),
      );
    }
    await q.run("UPDATE knowledge_sources SET facts_at = ?, updated_at = ? WHERE id = ?", now(), now(), source.id);
  });
}

/* ------------------------------------------------------------------ */
/* reconcile                                                           */
/* ------------------------------------------------------------------ */

/** Retires a source whose record has gone; re-reads one that still exists. */
async function reconcile(source: SourceRow): Promise<void> {
  const collected = await collect(source.kind, source.ref_id);
  if (!collected) await retire(source.id, "GONE");
  else await enqueueJob(source.id, "index");
}
