# The organisational memory

What it is: every record the platform keeps — tasks, meetings, journal
entries, chat messages and voice notes, project documents, agreements,
project passports, and the files uploaded to the library at `/knowledge` —
is read once into `knowledge_sources` / `knowledge_chunks` / `knowledge_facts`
and kept searchable there. The AI chat at `/assistant` answers from it with
citations; every citation opens the original record, and "evidence" opens
the passages the answer rested on.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Already used by the agents. Needed for PDF/image reading, fact extraction and the assistant's answers. Without it: Word/Excel/text are still indexed and searchable, the chat answers 503 `NO_KEY`. |
| `EMBEDDING_PROVIDER` | auto | `voyage`, `openai` or `none`. Unset: `voyage` if `VOYAGE_API_KEY` is set, else `openai` if `OPENAI_API_KEY` is set, else none. Without a provider retrieval is word matching only (prefix-matched, works across uz/ru/en inflection). |
| `VOYAGE_API_KEY` / `OPENAI_API_KEY` | — | The provider's key. |
| `EMBEDDING_MODEL` | `voyage-3.5` / `text-embedding-3-small` | Model name sent to the provider. Changing it re-embeds passages on the next `embed` job (old vectors are ignored by model name). |
| `KNOWLEDGE_WORKER` | `1` | `0` disables the in-process worker (tests, scripts, a box that must not run jobs). |
| `KNOWLEDGE_WORKER_INTERVAL_MS` | `30000` | How often the boot-time worker runs a pass. |
| `WHISPER_BIN`, `FFMPEG_BIN`, `WHISPER_MODEL`, `WHISPER_VAD_MODEL` | see Dockerfile | Already used for meeting recordings; voice notes in chat use the same local transcription. Without them a voice note's source is FAILED with `STT_UNAVAILABLE` and can be retried once they exist. |
| `BOT_NOTIFY_SECRET` | — | Also guards `POST /api/knowledge/worker`, so the bot's minute loop (or any scheduler) can drive the queue from outside the web process. |

No new services. Postgres 17 as deployed is enough: embeddings are stored
as `real[]` and compared by the SQL function `knowledge_cosine`; pgvector
is the upgrade path if the corpus grows past tens of thousands of passages.

## Background work

Nothing heavy runs in a request. A write route calls `remember(kind, id)`,
which inserts a `knowledge_jobs` row and answers. Jobs are picked up by:

1. the same process, a few milliseconds later (`kick()`);
2. the periodic pass started in `instrumentation.ts` (retries, stale jobs);
3. `POST /api/knowledge/worker` with header `X-Notify-Secret`, for the bot.

Claims use `FOR UPDATE SKIP LOCKED`, so several processes may run passes.
A failing job is retried four times with doubling delays, then stays
`FAILED`; the source shows the error and a "read again" button at
`/knowledge/sources/<id>`. Queue health: `GET /api/knowledge/status`
(counts, oldest waiting job, mean duration over 24h).

## First deployment

Apply the schema as always (`migrate()` at boot; the new statements are
`IF NOT EXISTS`). Then index what already exists, once:

```
curl -X POST https://assemblyos.uz/api/knowledge/backfill -H "Cookie: assambleya_session=<RAIS or AI_LAB session>"
```

It queues every existing record (idempotent — unchanged records are
recognised by fingerprint and cost one hash). With ~500 records and a key
configured expect a few minutes; PDFs and recordings dominate.

## Access control

Decided at retrieval against the live tables (`src/lib/knowledge/access.ts`),
never copied: a passage from a task is readable by whoever may open that task
now, a journal entry by whoever can see its project now, a meeting by the
register's scope, a chat line by its participants only — the chairman's
global AI view (TZ 4.2) does not reach private chats, and a library document
marked PRIVATE is its uploader's. Removing a record removes its passages at
once (`forget`), and a record that has vanished when a job runs is retired.

Every answer the assistant gives through the global view is still logged to
`audit_log` as before.
