# TZ blocks 5–8 — what operations need to know

Companion to `DEPLOYMENT.md` and `DEPLOYMENT.knowledge.md`. Everything here
ships in the application; nothing needs a new service. The schema is applied
by `migrate()` at boot (`db/schema.postgres.sql`, idempotent).

## Schema additions

| Block | Tables / columns | Notes |
|---|---|---|
| 5 KPI | `settings` | one JSON row per key (`kpi`, `crm`, `tiers`, `signals`, `ai`), audited |
| 6 CRM | `uyushmalar.*` (names, kontur, responsible, head, status), `uyushma_projects`, `partners.stage/stage_since/deal_value/next_step/verification/uyushma_id`, `partner_stage_history` | one-time backfill `partner_stage_backfill` derives the stage from the old status |
| 8 | `project_decisions`, `loyihalar.last_reviewed_at`, `report_cache` | |

All new tables carry the archive-on-delete and audit triggers.

## Settings the chairman's side changes in the UI

| Key | Where | Defaults |
|---|---|---|
| `kpi` | `/kpi` | ratios per role, RAG thresholds, limits, monthly targets |
| `crm` | `/companies` (foot) | days per stage before a company reads as stuck |
| `tiers`, `signals` | `/dashboard` (foot) | review rhythm 7/30/90 days, red share 15/30/100 %, inactivity 14/30/90 days, contour floor 10 %, overload from 2 projects, red from 30 % overdue |
| `ai` | `/ai` (under the queue) | auto-approval **off**, limit P4, expiry 30 days |

Routes: `GET/PATCH /api/settings/{kpi,crm,tiers,ai}`; PATCH is `seesEverything` only.

## The sweep

`sweepReminders()` (already called by the bot/cron path) now also:

- notifies a company's owner once per stay when it is stuck (`partner-stuck-<id>`);
- archives proposals nobody looked at (`agent_proposals.status = 'expired'`) after `ai.expireDays`;
- refreshes `report_cache` for the current week and month when the copy is older than 15 minutes. `/reports` reads the cache (fresh ≤ 60 min, past periods for ever) and computes only when it has to.

Nothing else is scheduled. If the sweep is not running, the pages still work — they fall back to computing on request.

## Knowledge memory

- New source kinds: `uyushma` (block 6) and `partner` (block 7.3). After deploying, run `POST /api/knowledge/backfill` once (chairman's session) so existing associations and companies are indexed; new and edited records index themselves.
- `GET /api/knowledge/related?company=&uyushma=&project=&q=` is the historical reminder (7.4); it reads through the same permission filter as search.
- `GET /api/knowledge/search?uyushma=<id>` narrows to one association's records.

## AI intake (7.2)

The document and meeting agents gained the verb `suggest_record`. Approval of such a proposal creates an agreement (with parties and obligations), a company, a stage move or a project decision through the same library the forms use. Phase proposals require a real approver (never auto). The model is told the companies and projects that exist; drafts naming nothing in the base are dropped before they reach the queue.

## Tests

```
npm test                                              # unit tests, DB tests skipped
TEST_DATABASE_URL=postgres://localhost/asm_kb_test npm test   # also the DB tests
```

The DB tests (`crm-path-db`, `decisions-db`, `intake-records-db`, `knowledge-db`) refuse any database without `test` in its name and truncate the tables they use. `intake-records-db` runs the document intake against a stub Messages API (`test/helpers/stub-ai.ts`); no key, no network.

## Performance (8.5)

Lists are paged on the server: companies (30 per page, stuck filter in SQL), proposals (30 per page), agreements (already). The chairman's home runs one query over `loyihalar` with correlated counts; with 100 projects and 10,000 tasks it stays well under a second on the demo host (see the status note for the measurement).
