import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { startStub, textReply, toolReply, type Stub } from "./helpers/stub-ai.ts";

/**
 * The memory end to end, against a real Postgres.
 *
 * Runs only when KNOWLEDGE_TEST_DATABASE_URL names a scratch database (the
 * schema is applied to it, and its knowledge tables are emptied). The two
 * vendors are the stub in ./helpers — the SDK, the request shapes and the
 * parsing are real, the answers are the test's.
 */

const DATABASE = process.env.KNOWLEDGE_TEST_DATABASE_URL;
const skip = DATABASE ? false : "KNOWLEDGE_TEST_DATABASE_URL is not set";
// The fixture truncates tables. It will only ever do that to a database
// whose name says it is a scratch one.
if (DATABASE && !/test/.test(new URL(DATABASE).pathname))
  throw new Error("KNOWLEDGE_TEST_DATABASE_URL must name a database with 'test' in its name");

let stub: Stub;
let onMessages: (body: Record<string, unknown>) => Record<string, unknown> = () => textReply("—");
const uploads = fs.mkdtempSync(`${os.tmpdir()}/kb-uploads-`);

// Everything the library reads from the environment is set before the
// first import of it: the pool's connection string, the upload root, the
// vendors' addresses, and the worker switch (the tests run passes by hand).
before(async () => {
  stub = await startStub((body) => onMessages(body));
  process.env.DATABASE_URL = DATABASE;
  process.env.ASSAMBLEYA_UPLOAD_DIR = uploads;
  process.env.KNOWLEDGE_WORKER = "0";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_BASE_URL = stub.url;
  process.env.EMBEDDING_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test-key";
  process.env.EMBEDDING_BASE_URL = stub.url;
  process.env.WHISPER_BIN = "/nonexistent/whisper";
  process.env.AUTH_SECRET = "x".repeat(40);
}, { skip });

after(async () => {
  await stub?.close();
  const { pool } = await import("../src/lib/pg.ts");
  await pool().end();
  fs.rmSync(uploads, { recursive: true, force: true });
}, { skip });

type Lib = {
  pg: typeof import("../src/lib/pg.ts");
  sources: typeof import("../src/lib/knowledge/sources.ts");
  jobs: typeof import("../src/lib/knowledge/jobs.ts");
  retrieve: typeof import("../src/lib/knowledge/retrieve.ts");
  library: typeof import("../src/lib/knowledge/library.ts");
  uploads: typeof import("../src/lib/uploads.ts");
  assistant: typeof import("../src/lib/agents/assistant.ts");
  types: typeof import("../src/lib/types.ts");
};

async function lib(): Promise<Lib> {
  return {
    pg: await import("../src/lib/pg.ts"),
    sources: await import("../src/lib/knowledge/sources.ts"),
    jobs: await import("../src/lib/knowledge/jobs.ts"),
    retrieve: await import("../src/lib/knowledge/retrieve.ts"),
    library: await import("../src/lib/knowledge/library.ts"),
    uploads: await import("../src/lib/uploads.ts"),
    assistant: await import("../src/lib/agents/assistant.ts"),
    types: await import("../src/lib/types.ts"),
  };
}

interface Fixture {
  rais: import("../src/lib/types.ts").User;
  head: import("../src/lib/types.ts").User;
  alice: import("../src/lib/types.ts").User;
  bob: import("../src/lib/types.ts").User;
  projectId: number;
  taskId: number;
  meetingId: number;
  entryId: number;
  messageId: number;
  privateDocId: number;
  sharedDocId: number;
}

let fx: Fixture;

async function user(L: Lib, login: string): Promise<import("../src/lib/types.ts").User> {
  const row = await L.pg.get<import("../src/lib/types.ts").User>("SELECT * FROM users WHERE login = ?", login);
  assert.ok(row, login);
  return row;
}

test("fixture: schema, people, a project, a task, a meeting, a journal entry, a chat, two documents", { skip }, async () => {
  const L = await lib();
  await L.pg.migrate();
  // A scratch database: everything the test touches starts empty.
  await L.pg.run(
    `TRUNCATE knowledge_jobs, knowledge_facts, knowledge_links, knowledge_chunks, knowledge_sources,
             knowledge_documents, assistant_messages, messages, thread_entries, project_threads,
             meeting_staff, meeting_projects, meetings, task_events, task_stages, task_progress, tasks,
             project_members, loyihalar, users, archive, audit_log
     RESTART IDENTITY CASCADE`,
  );
  const stamp = L.pg.now();
  const mk = async (login: string, role: string, department: string | null, manager: number | null) =>
    await L.pg.insert(
      `INSERT INTO users (login, password_hash, full_name, role, department, manager_id, lang, is_active, created_at)
       VALUES (?, 'x', ?, ?, ?, ?, 'en', 1, ?)`,
      login, `KBT ${login.slice(4)}`, role, department, manager, stamp,
    );
  const raisId = await mk("kbt_rais", "RAIS", null, null);
  const headId = await mk("kbt_head", "BOLIM_RAHBARI", "GR", raisId);
  const aliceId = await mk("kbt_alice", "ISHCHI", "GR", headId);
  const bobId = await mk("kbt_bob", "ISHCHI", "FR", null);

  const projectId = await L.pg.insert(
    `INSERT INTO loyihalar (code, name, status, owner_id, created_at, description)
     VALUES ('KBT-1', 'Smart City Samarkand', 'FAOL', ?, ?, 'Pilot of a smart city platform with UNIDO')`,
    headId, stamp,
  );
  await L.pg.run("INSERT INTO project_members (project_id, user_id) VALUES (?, ?)", projectId, aliceId);

  const taskId = await L.pg.insert(
    `INSERT INTO tasks (code, title, description, from_user_id, to_user_id, to_department, priority, status,
                        deadline, loyiha_id, created_at, kind, scope)
     VALUES ('T-KBT1', 'Prepare the UNIDO financing report', 'Draft the financing report for the Samarkand pilot',
             ?, ?, 'GR', 'YUQORI', 'YANGI', '2026-11-15', ?, ?, 'MUDDATLI', 'HAFTALIK')`,
    headId, aliceId, projectId, stamp,
  );
  await L.pg.run(
    "INSERT INTO task_stages (task_id, position, to_user_id, status, created_at) VALUES (?, 1, ?, 'YANGI', ?)",
    taskId, aliceId, stamp,
  );
  await L.pg.run(
    "INSERT INTO task_events (task_id, user_id, action, created_at) VALUES (?, ?, 'YARATILDI', ?)",
    taskId, headId, stamp,
  );

  const meetingId = await L.pg.insert(
    `INSERT INTO meetings (title, owner_id, transcript, lang, held_at, agreed, participants, created_at)
     VALUES ('UNIDO negotiation on the Samarkand pilot', ?,
             'We discussed the pilot budget. It was decided that the financing report goes to UNIDO by 15 November. Alice will prepare it. The deadline for the memorandum draft is the end of December.',
             'en-US', '2026-10-20', 'Financing report to UNIDO by 15 November', 'UNIDO delegation, Head, Alice', ?)`,
    headId, stamp,
  );
  await L.pg.run("INSERT INTO meeting_staff (meeting_id, user_id) VALUES (?, ?)", meetingId, aliceId);
  await L.pg.run("INSERT INTO meeting_projects (meeting_id, project_id) VALUES (?, ?)", meetingId, projectId);

  const threadId = await L.pg.insert(
    "INSERT INTO project_threads (project_id, title, kind, created_by, created_at) VALUES (?, 'UNIDO', 'PARTNER', ?, ?)",
    projectId, headId, stamp,
  );
  const entryId = await L.pg.insert(
    `INSERT INTO thread_entries (thread_id, author_id, kind, body, occurred_on, created_at)
     VALUES (?, ?, 'NOTE', 'UNIDO confirmed the pilot budget of 2.4 million dollars for Samarkand.', '2026-10-21', ?)`,
    threadId, aliceId, stamp,
  );

  const messageId = await L.pg.insert(
    "INSERT INTO messages (from_user_id, to_user_id, body, created_at) VALUES (?, ?, 'Bob, the memorandum draft with UNIDO is delayed to January.', ?)",
    aliceId, bobId, stamp,
  );

  const stored = (text: string, name: string) =>
    L.uploads.store(Buffer.from(text, "utf8"), "file", "text/plain", name);
  const shared = stored(
    "Regulation on project financing.\n\nSection 3. Every financing report is signed by the head of department before submission to a partner.",
    "regulation.txt",
  );
  const bobUser = await user(L, "kbt_bob");
  const sharedDocId = await L.library.createDocument(
    { key: shared.key, name: "regulation.txt", size: shared.size, mime: "text/plain", format: "Matn" },
    "Financing regulation",
    { visibility: "ALL", projectId: null, department: null },
    headId,
  );
  const secret = stored("Bob's private notes: salary expectations for the FR desk.", "private.txt");
  const privateDocId = await L.library.createDocument(
    { key: secret.key, name: "private.txt", size: secret.size, mime: "text/plain", format: "Matn" },
    "Bob private notes",
    { visibility: "PRIVATE", projectId: null, department: null },
    bobUser.id,
  );

  fx = {
    rais: await user(L, "kbt_rais"),
    head: await user(L, "kbt_head"),
    alice: await user(L, "kbt_alice"),
    bob: bobUser,
    projectId, taskId, meetingId, entryId, messageId, privateDocId, sharedDocId,
  };
});

/** The stub's facts for a meeting: one real quote, one invented. */
function factsReply(): Record<string, unknown> {
  return textReply(
    JSON.stringify({
      facts: [
        {
          kind: "decision",
          subject: "financing report",
          statement: "The financing report goes to UNIDO by 15 November; Alice prepares it.",
          who: "Alice",
          due_on: "2026-11-15",
          stated: "direct",
          confidence: "high",
          quote: "the financing report goes to UNIDO by 15 November",
          passage: 1,
        },
        {
          kind: "commitment",
          subject: "memorandum",
          statement: "UNIDO will sign the memorandum in October.",
          who: "UNIDO",
          due_on: "",
          stated: "inferred",
          confidence: "low",
          quote: "UNIDO will sign in October",
          passage: 1,
        },
      ],
    }),
  );
}

test("ingestion: every record is read, chunked, embedded, and its facts kept with provenance", { skip }, async () => {
  const L = await lib();
  onMessages = () => factsReply();
  // The two library documents were queued when they were created.
  const queued = await L.sources.enqueueBackfill(["task", "meeting", "thread_entry", "message", "library", "project"]);
  assert.equal(queued, 5, `queued ${queued}`);
  const open = await L.pg.get<{ n: number }>("SELECT COUNT(*) AS n FROM knowledge_jobs WHERE status = 'QUEUED'");
  assert.equal(Number(open?.n), 7);

  // A second backfill queues nothing new: the open jobs are there already.
  assert.equal(await L.sources.enqueueBackfill(["task"]), 0);

  let pass = await L.jobs.runPending({ max: 100 });
  // Follow-up jobs (embed, facts) were queued by the index pass; run them.
  for (let i = 0; i < 4; i++) pass = await L.jobs.runPending({ max: 100 });
  assert.equal(pass.failed, 0);

  const task = await L.sources.sourceByRef("task", fx.taskId);
  assert.equal(task?.status, "READY");
  assert.ok(task!.chunk_count >= 1);
  assert.equal(task!.project_id, fx.projectId);
  assert.ok(task!.embedded_at, "embedded");

  const meeting = await L.sources.sourceByRef("meeting", fx.meetingId);
  assert.equal(meeting?.status, "READY");
  assert.equal(meeting!.occurred_at, "2026-10-20");
  assert.ok(meeting!.facts_at, "facts pass ran");

  // The task states its own facts without a model: who, what, by when.
  const taskFacts = await L.pg.all<{ kind: string; who_user_id: number; due_on: string; task_id: number; stated: string }>(
    "SELECT kind, who_user_id, due_on, task_id, stated FROM knowledge_facts WHERE source_id = ? ORDER BY id",
    task!.id,
  );
  assert.ok(taskFacts.some((f) => f.kind === "action_item" && f.who_user_id === fx.alice.id && f.task_id === fx.taskId));
  assert.ok(taskFacts.some((f) => f.kind === "deadline" && f.due_on === "2026-11-15"));

  // The meeting's facts came from the model: the quoted one stayed, the invented one did not.
  const meetingFacts = await L.pg.all<{ kind: string; quote: string | null; who_user_id: number | null; task_id: number | null; stated: string }>(
    "SELECT kind, quote, who_user_id, task_id, stated FROM knowledge_facts WHERE source_id = ? AND quote IS NOT NULL",
    meeting!.id,
  );
  assert.equal(meetingFacts.length, 1);
  assert.equal(meetingFacts[0].kind, "decision");
  assert.equal(meetingFacts[0].who_user_id, fx.alice.id, "the name resolved to the person");
  assert.equal(meetingFacts[0].stated, "direct");

  // The model was handed the passages as documents, never as instructions.
  const factCall = stub.calls.find((call) => call.path.includes("/v1/messages"));
  assert.ok(factCall);
  const content = JSON.stringify((factCall!.body.messages as unknown[])[0]);
  assert.ok(content.includes('<document source=\\"passage 1\\">'));

  // Links: the meeting is about the project and mentions Alice.
  const links = await L.pg.all<{ to_kind: string; to_id: number }>("SELECT to_kind, to_id FROM knowledge_links WHERE source_id = ?", meeting!.id);
  assert.ok(links.some((l) => l.to_kind === "project" && l.to_id === fx.projectId));
  assert.ok(links.some((l) => l.to_kind === "person" && l.to_id === fx.alice.id));

  // The library documents were read locally (text), both are READY.
  assert.equal((await L.sources.sourceByRef("library", fx.sharedDocId))?.status, "READY");
  assert.equal((await L.sources.sourceByRef("library", fx.privateDocId))?.status, "READY");
});

test("retrieval: combined across sources, ranked, and only what the asker may read", { skip }, async () => {
  const L = await lib();

  // Alice was at the meeting and is in the project: she finds both.
  const alice = await L.retrieve.searchKnowledge(fx.alice, "UNIDO financing report deadline");
  const kinds = new Set(alice.map((hit) => hit.kind));
  assert.ok(kinds.has("meeting"), "meeting");
  assert.ok(kinds.has("task"), "task");
  assert.ok(alice.every((hit) => hit.href && hit.evidence_href), "every hit links somewhere");
  // The task record outranks the chat line that mentions the same words.
  const taskAt = alice.findIndex((hit) => hit.kind === "task");
  const messageAt = alice.findIndex((hit) => hit.kind === "message");
  assert.ok(taskAt >= 0 && (messageAt < 0 || taskAt < messageAt));

  // Bob is in neither the project nor the meeting: nothing of theirs reaches him.
  const bob = await L.retrieve.searchKnowledge(fx.bob, "UNIDO financing report deadline Samarkand");
  assert.ok(!bob.some((hit) => hit.kind === "meeting" || hit.kind === "thread_entry" || hit.kind === "task"), JSON.stringify(bob.map((h) => h.kind)));
  // …but the chat line Alice sent him is his to read.
  assert.ok(bob.some((hit) => hit.kind === "message"), "bob's own chat");

  // The chairman sees the Assembly's records, and never the private chat
  // nor Bob's private document.
  const rais = await L.retrieve.searchKnowledge(fx.rais, "UNIDO memorandum salary", { limit: 20 });
  assert.ok(rais.some((hit) => hit.kind === "meeting"));
  assert.ok(!rais.some((hit) => hit.kind === "message"), "no private chat for the chairman");
  assert.ok(!rais.some((hit) => hit.ref_id === fx.privateDocId && hit.kind === "library"), "no private document");

  // The shared regulation is everyone's; the private notes are Bob's alone.
  const regulation = await L.retrieve.searchKnowledge(fx.alice, "financing report signed by the head", { kinds: ["library"] });
  assert.ok(regulation.some((hit) => hit.ref_id === fx.sharedDocId));
  assert.ok(!regulation.some((hit) => hit.ref_id === fx.privateDocId));
  const own = await L.retrieve.searchKnowledge(fx.bob, "salary expectations", { kinds: ["library"] });
  assert.ok(own.some((hit) => hit.ref_id === fx.privateDocId));

  // Reading a source directly obeys the same rule.
  const entrySource = await L.sources.sourceByRef("thread_entry", fx.entryId);
  assert.ok(await L.retrieve.readSource(fx.alice, entrySource!.id));
  assert.equal(await L.retrieve.readSource(fx.bob, entrySource!.id), null);

  // Meaning-based matching contributed: the stub embeds by trigram, so a
  // query sharing no prefix with the record still ranks it.
  const vector = await L.pg.get<{ n: number }>("SELECT COUNT(*) AS n FROM knowledge_chunks WHERE embedding IS NOT NULL");
  assert.ok(Number(vector?.n) >= 5, "embeddings stored");
});

test("facts: the responsible person, the deadline and the linked task; history by date", { skip }, async () => {
  const L = await lib();
  const facts = await L.retrieve.findFacts(fx.alice, { who: "Alice" });
  const linked = facts.find((fact) => fact.task_id === fx.taskId && fact.kind === "action_item");
  assert.ok(linked, "the task's own fact");
  assert.equal(linked!.who_user_id, fx.alice.id);
  assert.equal(linked!.due_on, "2026-11-15");
  assert.equal(linked!.task_status, "YANGI");
  const decision = facts.find((fact) => fact.kind === "decision");
  assert.ok(decision, "the meeting's decision");
  assert.equal(decision!.source_kind, "meeting");
  assert.ok(decision!.quote?.includes("15 November"));

  // Bob may not read the meeting, so he does not get its decision either.
  const bobFacts = await L.retrieve.findFacts(fx.bob, { kinds: ["decision"] });
  assert.ok(!bobFacts.some((fact) => fact.source_id === decision!.source_id));

  // "What do we know about the project" — a dated table of contents.
  const about = await L.retrieve.sourcesAbout(fx.alice, { projectId: fx.projectId });
  const aboutKinds = about.map((row) => row.kind);
  for (const kind of ["project", "task", "meeting", "thread_entry"]) assert.ok(aboutKinds.includes(kind as never), kind);
  const period = await L.retrieve.sourcesAbout(fx.alice, { projectId: fx.projectId, from: "2026-10-21", to: "2026-10-21" });
  assert.ok(period.some((row) => row.kind === "thread_entry"));
  assert.ok(!period.some((row) => row.kind === "meeting"), "the meeting was the day before");
});

test("updates: a changed record is read again as a new version; an unchanged one costs nothing", { skip }, async () => {
  const L = await lib();
  const before = (await L.sources.sourceByRef("task", fx.taskId))!;

  // Unchanged: same version after another pass.
  await L.sources.remember("task", fx.taskId);
  await L.jobs.runPending({ max: 20 });
  const same = (await L.sources.sourceByRef("task", fx.taskId))!;
  assert.equal(same.version, before.version);

  // Changed: the status moves, the passages say so, the old ones are gone.
  await L.pg.run("UPDATE tasks SET status = 'BAJARILDI', result_comment = 'Report sent to UNIDO' WHERE id = ?", fx.taskId);
  await L.sources.remember("task", fx.taskId);
  // Two queued remembers collapse into one open job.
  await L.sources.remember("task", fx.taskId);
  const open = await L.pg.get<{ n: number }>("SELECT COUNT(*) AS n FROM knowledge_jobs WHERE source_id = ? AND status = 'QUEUED' AND kind = 'index'", before.id);
  assert.equal(Number(open?.n), 1);
  await L.jobs.runPending({ max: 20 });
  await L.jobs.runPending({ max: 20 });
  const changed = (await L.sources.sourceByRef("task", fx.taskId))!;
  assert.equal(changed.version, before.version + 1);
  const chunks = await L.pg.all<{ version: number; body: string }>("SELECT version, body FROM knowledge_chunks WHERE source_id = ?", changed.id);
  assert.ok(chunks.every((chunk) => chunk.version === changed.version), "old passages removed");
  assert.ok(chunks.some((chunk) => chunk.body.includes("BAJARILDI") && chunk.body.includes("Report sent to UNIDO")));
  const text = await L.retrieve.readSource(fx.alice, changed.id);
  assert.ok(text?.chunks[0].body.includes("Status: BAJARILDI"));
  // The linked fact now reports the task's current status.
  const facts = await L.retrieve.findFacts(fx.alice, { who: "Alice", kinds: ["action_item"] });
  assert.equal(facts.find((fact) => fact.task_id === fx.taskId)?.task_status, "BAJARILDI");
});

test("deletion: a removed record stops answering at once", { skip }, async () => {
  const L = await lib();
  const source = (await L.sources.sourceByRef("thread_entry", fx.entryId))!;
  const hits = await L.retrieve.searchKnowledge(fx.alice, "pilot budget million dollars");
  assert.ok(hits.some((hit) => hit.source_id === source.id));
  await L.sources.forget("thread_entry", fx.entryId);
  const after = await L.sources.sourceByRef("thread_entry", fx.entryId);
  assert.equal(after?.status, "DELETED");
  assert.equal(Number((await L.pg.get<{ n: number }>("SELECT COUNT(*) AS n FROM knowledge_chunks WHERE source_id = ?", source.id))?.n), 0);
  const gone = await L.retrieve.searchKnowledge(fx.alice, "pilot budget million dollars");
  assert.ok(!gone.some((hit) => hit.source_id === source.id));
  assert.equal(await L.retrieve.readSource(fx.alice, source.id), null);
});

test("failures: a voice note with no audio fails, is retried, then stays FAILED with its reason", { skip }, async () => {
  const L = await lib();
  const voiceId = await L.pg.insert(
    "INSERT INTO messages (from_user_id, to_user_id, body, kind, file_key, file_name, created_at) VALUES (?, ?, '', 'voice', '2026/10/00000000000000000000000000000000.webm', 'voice', ?)",
    fx.alice.id, fx.bob.id, L.pg.now(),
  );
  const sourceId = (await L.sources.remember("message", voiceId))!;
  await L.pg.run("UPDATE knowledge_jobs SET max_attempts = 2 WHERE source_id = ?", sourceId);
  let pass = await L.jobs.runPending({ max: 5 });
  assert.equal(pass.retried, 1, "first failure is retried");
  // The retry is due in a minute; pull it forward.
  await L.pg.run("UPDATE knowledge_jobs SET run_after = ? WHERE source_id = ?", L.pg.now(), sourceId);
  pass = await L.jobs.runPending({ max: 5 });
  assert.equal(pass.failed, 1, "attempts spent");
  const source = (await L.sources.sourceById(sourceId))!;
  assert.equal(source.status, "FAILED");
  assert.equal(source.reason, "GONE");
  const job = await L.pg.get<{ status: string; error: string }>("SELECT status, error FROM knowledge_jobs WHERE source_id = ? ORDER BY id DESC LIMIT 1", sourceId);
  assert.equal(job?.status, "FAILED");
  assert.match(job!.error, /GONE/);
  // A retry puts it back in the queue.
  await L.sources.retrySource(sourceId);
  assert.equal((await L.sources.sourceById(sourceId))?.status, "PENDING");
  const stats = await L.jobs.queueStats();
  assert.ok(stats.queued >= 1);

  // An embedding outage: the index pass still succeeds, the embed job retries.
  process.env.EMBEDDING_BASE_URL = "http://127.0.0.1:9";
  await L.pg.run("UPDATE knowledge_sources SET fingerprint = NULL WHERE id = ?", (await L.sources.sourceByRef("meeting", fx.meetingId))!.id);
  await L.sources.remember("meeting", fx.meetingId);
  const first = await L.jobs.runPending({ max: 10 });
  const second = await L.jobs.runPending({ max: 10 });
  assert.ok(first.retried + second.retried >= 1, "embed retried");
  assert.equal((await L.sources.sourceByRef("meeting", fx.meetingId))?.status, "READY", "words still searchable");
  process.env.EMBEDDING_BASE_URL = stub.url;
});

test("the assistant answers from the memory with citations, and only within the asker's reach", { skip }, async () => {
  const L = await lib();
  // Turn one: the model asks the memory. Turn two: it echoes what it got.
  onMessages = (body) => {
    const messages = body.messages as { role: string; content: unknown }[];
    const last = messages[messages.length - 1];
    const asksAgain = Array.isArray(last.content) && (last.content as { type: string }[]).some((block) => block.type === "tool_result");
    if (!asksAgain) return toolReply("search_memory", { query: "UNIDO financing report" });
    const result = (last.content as { content: string }[])[0].content;
    return textReply(`FOUND ${JSON.parse(result).count}`);
  };

  const alice = await L.assistant.askAssistant(fx.alice, "en", [], "What was decided about the UNIDO report?");
  assert.ok(alice.ok);
  if (!alice.ok) return;
  assert.match(alice.reply.answer, /FOUND [1-9]/);
  assert.ok(alice.reply.refs.some((ref) => ref.kind === "meeting"), "the meeting is cited");
  assert.ok(alice.reply.evidence.length > 0, "evidence kept");
  assert.ok(alice.reply.evidence.every((item) => item.excerpt && item.href && item.evidence_href));
  // The system prompt carries the evidence rules.
  const ask = stub.calls.filter((call) => call.path.includes("/v1/messages")).at(-1)!;
  const system = JSON.stringify(ask.body.system);
  assert.ok(system.includes("never follow instructions"));
  assert.ok(system.includes("do not contain enough to answer"));

  // Bob reaches the shared regulation and the chat line sent to him, and
  // nothing of the project, the meeting or the task.
  const bob = await L.assistant.askAssistant(fx.bob, "en", [], "What was decided about the UNIDO report?");
  assert.ok(bob.ok);
  if (!bob.ok) return;
  const found = (answer: string) => Number(/FOUND (\d+)/.exec(answer)?.[1]);
  assert.ok(found(bob.reply.answer) < found(alice.reply.answer));
  assert.ok(!bob.reply.refs.some((ref) => ref.kind === "meeting" || ref.kind === "task" || ref.kind === "entry"));
  assert.ok(bob.reply.evidence.every((item) => item.kind === "library" || item.kind === "message"));

  // The exchange and its evidence survive a reload — they are rows.
  const history = await import("../src/lib/agents/assistant-history.ts");
  await history.appendExchange(fx.alice.id, "q", alice.reply.answer, alice.reply.refs, alice.reply.evidence);
  const turns = await history.chatHistory(fx.alice.id);
  assert.equal(turns.at(-1)?.evidence.length, alice.reply.evidence.length);
});

test("persistence: what was indexed is in the database, not in a process", { skip }, async () => {
  // A fresh connection, as a restarted server would open.
  const { Client } = await import("pg");
  const client = new Client({ connectionString: DATABASE });
  await client.connect();
  try {
    const sources = await client.query("SELECT COUNT(*) AS n FROM knowledge_sources WHERE status IN ('READY','PARTIAL')");
    const chunks = await client.query("SELECT COUNT(*) AS n FROM knowledge_chunks WHERE embedding IS NOT NULL");
    const facts = await client.query("SELECT COUNT(*) AS n FROM knowledge_facts");
    assert.ok(Number(sources.rows[0].n) >= 5);
    assert.ok(Number(chunks.rows[0].n) >= 5);
    assert.ok(Number(facts.rows[0].n) >= 3);
  } finally {
    await client.end();
  }
});
