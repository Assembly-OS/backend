import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startStub, textReply, type Stub } from "./helpers/stub-ai.ts";

/**
 * TZ 7.1 and 7.2 end to end: a document goes in, the model (a stub here,
 * answering with the analysis the test wrote) drafts an assignment, an
 * agreement, a company, a stage move and a phase; the drafts sit in the
 * queue, are filtered, approved in bulk, and become records. Then the
 * auto-approval switch and the expiry sweep.
 */

const DATABASE = process.env.TEST_DATABASE_URL ?? process.env.KNOWLEDGE_TEST_DATABASE_URL;
const skip = DATABASE ? false : "TEST_DATABASE_URL is not set";
if (DATABASE && !/test/.test(new URL(DATABASE).pathname))
  throw new Error("TEST_DATABASE_URL must name a database with 'test' in its name");

let stub: Stub;
let analysis: Record<string, unknown> = {};

before(async () => {
  stub = await startStub(() => textReply(JSON.stringify(analysis)));
  process.env.DATABASE_URL = DATABASE;
  process.env.KNOWLEDGE_WORKER = "0";
  process.env.EMBEDDING_PROVIDER = "none";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.ANTHROPIC_BASE_URL = stub.url;
  process.env.AUTH_SECRET = "x".repeat(40);
}, { skip });

after(async () => {
  await stub?.close();
  const { pool } = await import("../src/lib/pg.ts");
  await pool().end();
}, { skip });

type User = import("../src/lib/types.ts").User;

async function lib() {
  return {
    pg: await import("../src/lib/pg.ts"),
    runner: await import("../src/lib/agents/intake-runner.ts"),
    orchestrator: await import("../src/lib/agents/orchestrator.ts"),
    settings: await import("../src/lib/settings.ts"),
    crm: await import("../src/lib/crm.ts"),
    decisions: await import("../src/lib/project-decisions.ts"),
  };
}

let head: User;
let worker: User;
let parsons: number;
let project: number;

const SOURCE = { kind: "text" as const, text: "Memorandum between the Assembly and Parsons Corp.", mediaType: "text/plain", label: "Matn" };

test("fixture: a head and a worker in GR, a company, a project", { skip }, async () => {
  const L = await lib();
  await L.pg.migrate();
  await L.pg.run(
    `TRUNCATE agent_proposals, agent_runs, agreements, kelishuv_parties, kelishuvlar, project_decisions,
             partner_stage_history, contacts, partners, task_events, task_stages, tasks, loyihalar, settings, users, archive, audit_log
     RESTART IDENTITY CASCADE`,
  );
  const stamp = L.pg.now();
  const mk = async (login: string, role: string, manager: number | null) =>
    await L.pg.insert(
      `INSERT INTO users (login, password_hash, full_name, role, department, manager_id, lang, is_active, created_at)
       VALUES (?, 'x', ?, ?, 'GR', ?, 'uz', 1, ?)`,
      login, `IRT ${login.slice(4)}`, role, manager, stamp,
    );
  const headId = await mk("irt_head", "BOLIM_RAHBARI", null);
  const workerId = await mk("irt_worker", "ISHCHI", headId);
  head = (await L.pg.get<User>("SELECT * FROM users WHERE id = ?", headId))!;
  worker = (await L.pg.get<User>("SELECT * FROM users WHERE id = ?", workerId))!;
  parsons = await L.crm.createCompany({ name: "Parsons Corporation", status: "POTENTIAL", owner_user_id: headId });
  project = await L.pg.insert(
    "INSERT INTO loyihalar (code, name, status, phase, tier, owner_id, created_at) VALUES ('IRT-1', 'Smart city', 'REJA', 'CONCEPT', 'ACTIVE', ?, ?)",
    headId, stamp,
  );
});

test("a signed document: the drafts land in the queue, filtered and paged", { skip }, async () => {
  const L = await lib();
  const today = L.pg.now().slice(0, 10);
  analysis = {
    documentTitle: "Memorandum with Parsons",
    kind: "SIGNED",
    summary: "A memorandum of understanding on engineering supervision.",
    tasks: [
      { title: "Prepare the supervision plan", description: "Per section 3", assignee: "irt_worker", priority: "ORTA", deadline: "", rationale: "section 3" },
    ],
    kelishuvlar: [
      {
        title: "MOU on engineering supervision",
        kind: "MOU",
        content: "Parsons supervises the Smart city site works.",
        parties: ["Parsons Corp."],
        amount: 2400000,
        currency: "USD",
        signed_on: today,
        valid_until: "",
        obligations: [{ description: "Send the term sheet", owner: "irt_worker", deadline: "2099-01-01" }],
        rationale: "page 1",
      },
    ],
    companies: [
      { name: "Parsons Corporation", industry: "", description: "", head_name: "", head_position: "", country: "", city: "", website: "", rationale: "" },
      { name: "Fresh Logistics LLC", industry: "Logistics", description: "Named as subcontractor", head_name: "A. Fresh", head_position: "CEO", country: "Uzbekistan", city: "Tashkent", website: "", rationale: "page 2" },
    ],
    stageUpdates: [
      { company: "Parsons Corporation", stage: "NEGOTIATION", rationale: "negotiation under way" },
      { company: "Nobody Inc", stage: "MEETING", rationale: "unknown" },
    ],
    phaseUpdates: [
      { project: "IRT-1", phase: "FEASIBILITY", rationale: "the report says the study started" },
      { project: "NOPE", phase: "EXECUTION", rationale: "" },
    ],
  };
  const result = await L.runner.runDocumentIntake(head, Buffer.from(SOURCE.text), SOURCE, "mou.txt", "k/mou.txt");
  assert.equal(result.status, "ok");
  assert.equal(result.created, 0, "the document agent queues, it does not create");
  assert.equal(result.drafts, 5, "a task, an agreement, a company, a stage, a phase");

  const page = await L.orchestrator.proposalsFor(head.id, { status: "pending" });
  assert.equal(page.total, 5);
  assert.equal(page.pages, 1);
  const kinds = page.rows.map((row) => row.action).sort();
  assert.deepEqual(kinds, ["suggest_record", "suggest_record", "suggest_record", "suggest_record", "suggest_task"]);
  assert.equal((await L.orchestrator.proposalsFor(head.id, { severity: "P2" })).total, 2, "the agreement and the phase");
  assert.equal((await L.orchestrator.proposalsFor(head.id, { assigneeId: worker.id })).total, 1);
  assert.equal((await L.orchestrator.proposalsFor(head.id, { from: "2099-01-01" })).total, 0);
  assert.equal((await L.orchestrator.proposalsFor(worker.id, {})).total, 0, "not his queue");
});

test("bulk approval turns the drafts into records through the same library the forms use", { skip }, async () => {
  const L = await lib();
  const pending = (await L.orchestrator.proposalsFor(head.id, { status: "pending" })).rows;
  const stageFirst = [...pending].sort((a, b) => (a.title.startsWith("Bosqich") ? -1 : b.title.startsWith("Bosqich") ? 1 : a.id - b.id));
  const outcome = await L.orchestrator.decideMany(stageFirst.map((p) => p.id), "approve", { id: head.id, login: head.login });
  assert.deepEqual(outcome.map((o) => o.ok), [true, true, true, true, true], JSON.stringify(outcome));

  // The agreement, with its party and its obligation.
  const kelishuv = await L.pg.get<{ id: number; status: string; amount: string; currency: string }>("SELECT id, status, amount, currency FROM kelishuvlar");
  assert.equal(kelishuv?.status, "OPEN");
  assert.equal(Number(kelishuv?.amount), 2400000);
  const party = await L.pg.get<{ company_id: number }>("SELECT company_id FROM kelishuv_parties WHERE kelishuv_id = ?", kelishuv!.id);
  assert.equal(party?.company_id, parsons, "'Parsons Corp.' matched the company in the base");
  const obligation = await L.pg.get<{ owner_user_id: number; kelishuv_id: number }>("SELECT owner_user_id, kelishuv_id FROM agreements");
  assert.equal(obligation?.owner_user_id, worker.id);
  assert.equal(obligation?.kelishuv_id, kelishuv!.id);

  // The company that was not in the base; the one that was, dropped.
  const fresh = await L.pg.get<{ stage: string; owner_user_id: number }>("SELECT stage, owner_user_id FROM partners WHERE name = 'Fresh Logistics LLC'");
  assert.equal(fresh?.stage, "NEW_CONTACT");
  assert.equal(fresh?.owner_user_id, head.id);
  assert.equal(Number((await L.pg.get<{ n: string }>("SELECT COUNT(*) AS n FROM partners WHERE name LIKE 'Parsons%'"))?.n), 1);

  // The stage move by hand, then the signed memorandum lifting it to AGREEMENT.
  const moves = (await L.crm.stageHistory(parsons)).map((m) => [m.to_stage, m.reason]);
  assert.deepEqual(moves, [["AGREEMENT", "kelishuv"], ["NEGOTIATION", "manual"], ["NEW_CONTACT", "manual"]]);

  // The phase, as a decision taken by the approver.
  const decisions = await L.decisions.decisionsOf(project);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].outcome, "CONTINUE");
  assert.equal(decisions[0].phase_to, "FEASIBILITY");
  assert.equal(decisions[0].decided_by, head.id);

  // The task, created for the worker.
  const task = await L.pg.get<{ to_user_id: number; title: string }>("SELECT to_user_id, title FROM tasks");
  assert.equal(task?.to_user_id, worker.id);
  assert.equal((await L.orchestrator.proposalsFor(head.id, { status: "executed" })).total, 5);
});

test("auto-approval, switched on by settings, files a low-risk draft as the record at once", { skip }, async () => {
  const L = await lib();
  analysis = {
    documentTitle: "Order 12",
    kind: "ORDER",
    summary: "An order.",
    tasks: [
      { title: "Routine report", description: "", assignee: "irt_worker", priority: "ORTA", deadline: "", rationale: "p.1" },
      { title: "Urgent fix", description: "", assignee: "irt_worker", priority: "KRITIK", deadline: "", rationale: "p.2" },
    ],
    kelishuvlar: [], companies: [], stageUpdates: [], phaseUpdates: [],
  };
  await L.settings.writeSetting(L.settings.AI_SETTINGS_KEY, { autoApprove: true, autoApproveMaxSeverity: "P3" }, head.id);
  const result = await L.runner.runDocumentIntake(head, Buffer.from("order"), SOURCE, "order.txt", "k/order.txt");
  assert.equal(result.created, 1, "the P3 draft became an assignment on its own");
  assert.equal(result.drafts, 1, "the P2 one waits for a person");
  const auto = await L.pg.get<{ decided_by: string; status: string }>("SELECT decided_by, status FROM agent_proposals WHERE title = 'Routine report'");
  assert.equal(auto?.status, "executed");
  assert.equal(auto?.decided_by, "auto");
  assert.equal((await L.pg.get<{ status: string }>("SELECT status FROM agent_proposals WHERE title = 'Urgent fix'"))?.status, "pending");
});

test("expiry: a proposal nobody looked at is archived after the days in settings", { skip }, async () => {
  const L = await lib();
  await L.pg.run("UPDATE agent_proposals SET created_at = '2020-01-01 00:00:00' WHERE title = 'Urgent fix'");
  assert.equal(await L.orchestrator.expireProposals(30), 1);
  assert.equal((await L.orchestrator.proposalsFor(head.id, { status: "expired" })).total, 1);
  assert.equal((await L.orchestrator.proposalsFor(head.id, { status: "pending" })).total, 0);
  const again = await L.orchestrator.decideMany([1], "approve", { id: head.id, login: head.login });
  assert.equal(again[0].ok, false, "an executed proposal is not decided twice");
});
