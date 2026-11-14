/**
 * The organisational memory, in one import.
 *
 * `remember` / `forget` are what write routes call; `searchKnowledge`,
 * `readSource`, `findFacts` and `sourcesAbout` are what the assistant's
 * tools call; the rest is for the pages. Everything is permission-aware
 * at the point of reading — see `access.ts`.
 */
export { remember, forget, retrySource, listSources, viewSource, memoryStats, enqueueBackfill, sourceById, sourceByRef } from "./sources";
export type { SourceFilter } from "./sources";
export { searchKnowledge, readSource, findFacts, sourcesAbout } from "./retrieve";
export type { Hit, FactHit, SourceSummary, SearchFilter, FactFilter, SourceText } from "./retrieve";
export { queueStats, runPending, startWorker, kick, workerEnabled } from "./jobs";
export type { QueueStats } from "./jobs";
export { embeddingConfigured } from "./embeddings";
export * from "./types";
