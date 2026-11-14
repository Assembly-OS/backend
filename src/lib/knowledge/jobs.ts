import { hostname } from "node:os";
import { all, get, now, run } from "../pg";

/**
 * The memory's work queue.
 *
 * Reading a PDF, transcribing a voice note, asking for embeddings and
 * extracting facts all take seconds to minutes, and none of it may run
 * inside the request that saved the record — a person sending a voice note
 * should not wait for Whisper. So the record's route queues a job and
 * answers; a worker picks the job up afterwards.
 *
 * There is no separate worker process to deploy. Three things drive the
 * queue, and any one of them is enough:
 *
 *  - `kick()` runs a pass in this process right after a job is queued, so
 *    on a quiet server a record is read within seconds of being saved;
 *  - `startWorker()` runs a pass every half minute from `instrumentation.ts`,
 *    which is what picks up retries and whatever a crash left behind;
 *  - `POST /api/knowledge/worker` runs a pass on request, for the bot's
 *    minute loop or an external scheduler.
 *
 * Claiming a job is `FOR UPDATE SKIP LOCKED`, so two processes running
 * passes at once take different jobs rather than the same one twice. A job
 * that fails is retried with a growing delay; after `max_attempts` it stays
 * FAILED and the source says so, with the error, until somebody retries it.
 */

export type JobKind = "index" | "embed" | "facts" | "reconcile";
export type JobStatus = "QUEUED" | "RUNNING" | "DONE" | "FAILED";

export interface Job {
  id: number;
  source_id: number;
  kind: JobKind;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_after: string;
  locked_at: string | null;
  locked_by: string | null;
  error: string | null;
  created_at: string;
}

/** A RUNNING job older than this belongs to a process that died. */
const STALE_AFTER_MS = 30 * 60_000;

function stamp(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Queues one job, or leaves the open one alone. The partial unique index on
 * (source, kind) is what makes a record edited three times in a minute read
 * once: the second and third insert hit the index and are dropped.
 */
export async function enqueueJob(
  sourceId: number,
  kind: JobKind = "index",
  delaySeconds = 0,
): Promise<boolean> {
  const rows = await all<{ id: number }>(
    `INSERT INTO knowledge_jobs (source_id, kind, run_after, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    sourceId,
    kind,
    stamp(delaySeconds * 1000),
    now(),
  );
  return rows.length > 0;
}

/** Takes the next due job, marking it as this worker's. */
export async function claimJob(workerId: string): Promise<Job | null> {
  const row = await get<Job>(
    `UPDATE knowledge_jobs SET status = 'RUNNING', locked_at = ?, locked_by = ?,
            attempts = attempts + 1
      WHERE id = (SELECT id FROM knowledge_jobs
                   WHERE status = 'QUEUED' AND run_after <= ?
                   ORDER BY id
                   LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    now(),
    workerId,
    now(),
  );
  return row ?? null;
}

export async function finishJob(id: number, durationMs: number): Promise<void> {
  await run(
    `UPDATE knowledge_jobs SET status = 'DONE', error = NULL, duration_ms = ?,
            finished_at = ?, locked_at = NULL, locked_by = NULL
      WHERE id = ?`,
    durationMs,
    now(),
    id,
  );
}

/**
 * Records a failure. Retried with a delay that doubles each time — a minute,
 * two, four — unless the attempts are spent, in which case the job stays
 * FAILED for a person to look at.
 */
export async function failJob(job: Job, error: string, durationMs: number): Promise<"retry" | "failed"> {
  const message = error.slice(0, 1000);
  if (job.attempts >= job.max_attempts) {
    await run(
      `UPDATE knowledge_jobs SET status = 'FAILED', error = ?, duration_ms = ?,
              finished_at = ?, locked_at = NULL, locked_by = NULL
        WHERE id = ?`,
      message,
      durationMs,
      now(),
      job.id,
    );
    return "failed";
  }
  const delay = 60_000 * 2 ** (job.attempts - 1);
  await run(
    `UPDATE knowledge_jobs SET status = 'QUEUED', error = ?, duration_ms = ?,
            run_after = ?, locked_at = NULL, locked_by = NULL
      WHERE id = ?`,
    message,
    durationMs,
    stamp(delay),
    job.id,
  );
  return "retry";
}

/** Puts jobs a dead process left RUNNING back in the queue. */
export async function requeueStale(): Promise<number> {
  const rows = await all<{ id: number }>(
    `UPDATE knowledge_jobs SET status = 'QUEUED', locked_at = NULL, locked_by = NULL,
            error = COALESCE(error, 'interrupted')
      WHERE status = 'RUNNING' AND locked_at < ?
      RETURNING id`,
    stamp(-STALE_AFTER_MS),
  );
  return rows.length;
}

/** Retries a FAILED job (or queues a fresh one) for a source. */
export async function retryJobs(sourceId: number): Promise<void> {
  await run(
    `UPDATE knowledge_jobs SET status = 'QUEUED', attempts = 0, run_after = ?, error = NULL
      WHERE source_id = ? AND status = 'FAILED'`,
    now(),
    sourceId,
  );
  await enqueueJob(sourceId, "index");
}

export interface QueueStats {
  queued: number;
  running: number;
  failed: number;
  /** Jobs finished in the last 24 hours, and their mean duration. */
  done_24h: number;
  mean_ms_24h: number | null;
  /** Age of the oldest job still waiting, in seconds. */
  oldest_waiting_s: number | null;
}

export async function queueStats(): Promise<QueueStats> {
  const row = await get<QueueStats>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'QUEUED')  AS queued,
       COUNT(*) FILTER (WHERE status = 'RUNNING') AS running,
       COUNT(*) FILTER (WHERE status = 'FAILED')  AS failed,
       COUNT(*) FILTER (WHERE status = 'DONE' AND finished_at >= ?) AS done_24h,
       AVG(duration_ms) FILTER (WHERE status = 'DONE' AND finished_at >= ?) AS mean_ms_24h,
       EXTRACT(EPOCH FROM (?::timestamp - MIN(created_at::timestamp) FILTER (WHERE status = 'QUEUED')))::int
         AS oldest_waiting_s
     FROM knowledge_jobs`,
    stamp(-86_400_000),
    stamp(-86_400_000),
    now(),
  );
  return {
    queued: Number(row?.queued ?? 0),
    running: Number(row?.running ?? 0),
    failed: Number(row?.failed ?? 0),
    done_24h: Number(row?.done_24h ?? 0),
    mean_ms_24h: row?.mean_ms_24h === null || row?.mean_ms_24h === undefined ? null : Number(row.mean_ms_24h),
    oldest_waiting_s:
      row?.oldest_waiting_s === null || row?.oldest_waiting_s === undefined
        ? null
        : Number(row.oldest_waiting_s),
  };
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

type Global = typeof globalThis & {
  __knowledgeWorker?: { running: boolean; again: boolean; timer?: NodeJS.Timeout };
};

function state() {
  const g = globalThis as Global;
  if (!g.__knowledgeWorker) g.__knowledgeWorker = { running: false, again: false };
  return g.__knowledgeWorker;
}

const WORKER_ID = `${hostname()}:${process.pid}`;

export interface PassResult {
  done: number;
  failed: number;
  retried: number;
}

/**
 * One pass over the queue: claim, process, repeat until nothing is due or
 * the time budget is spent. The budget keeps a pass from running for an
 * hour on a large backfill; the next pass picks up where this one stopped.
 */
export async function runPending(
  options: { budgetMs?: number; max?: number } = {},
): Promise<PassResult> {
  const budgetMs = options.budgetMs ?? 55_000;
  const max = options.max ?? 50;
  const started = Date.now();
  const result: PassResult = { done: 0, failed: 0, retried: 0 };

  await requeueStale();
  // Imported here rather than at the top: the pipeline queues jobs through
  // this module, and a static import each way would be a cycle.
  const { processJob } = await import("./pipeline");

  for (let count = 0; count < max && Date.now() - started < budgetMs; count++) {
    const job = await claimJob(WORKER_ID);
    if (!job) break;
    const at = Date.now();
    try {
      await processJob(job);
      await finishJob(job.id, Date.now() - at);
      result.done++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[knowledge] job ${job.id} (${job.kind}) failed:`, message);
      const outcome = await failJob(job, message, Date.now() - at);
      if (outcome === "failed") result.failed++;
      else result.retried++;
    }
  }
  return result;
}

/** Whether this process runs the queue at all. Off for tests and scripts. */
export function workerEnabled(): boolean {
  return process.env.KNOWLEDGE_WORKER !== "0";
}

/**
 * Runs a pass soon, in this process, once. Called after a job is queued.
 * A pass already under way notes that more arrived and runs again when it
 * finishes; nothing is ever run twice at once in one process.
 */
export function kick(): void {
  if (!workerEnabled()) return;
  const worker = state();
  if (worker.running) {
    worker.again = true;
    return;
  }
  worker.running = true;
  setTimeout(() => {
    runPending()
      .catch((error) => console.error("[knowledge] worker pass failed:", error))
      .finally(() => {
        worker.running = false;
        if (worker.again) {
          worker.again = false;
          kick();
        }
      });
  }, 50);
}

/**
 * The periodic pass, started once per process at boot. Retries and anything
 * queued by another process are picked up here; `kick()` covers the common
 * case faster.
 */
export function startWorker(intervalMs = 30_000): void {
  if (!workerEnabled()) return;
  const worker = state();
  if (worker.timer) return;
  worker.timer = setInterval(() => kick(), intervalMs);
  // Never keep a process alive for the sake of the timer.
  worker.timer.unref?.();
  kick();
}
