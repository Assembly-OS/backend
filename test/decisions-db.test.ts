import { test, before, after } from "node:test";
import assert from "node:assert/strict";

/**
 * Decision points, review cadence and the signals against a real Postgres
 * (TZ 7.5, 8.2–8.4). Same guard as the other database tests: a scratch
 * database with 'test' in its name, named by TEST_DATABASE_URL.
 */

const DATABASE = process.env.TEST_DATABASE_URL ?? process.env.KNOWLEDGE_TEST_DATABASE_URL;
const skip = DATABASE ? false : "TEST_DATABASE_URL is not set";
if (DATABASE && !/test/.test(new URL(DATABASE).pathname))
  throw new Error("TEST_DATABASE_URL must name a database with 'test' in its name");

before(() => {
  process.env.DATABASE_URL = DATABASE;
  process.env.KNOWLEDGE_WORKER = "0";
  process.env.EMBEDDING_PROVIDER = "none";
  process.env.AUTH_SECRET = "x".repeat(40);
}, { skip });

after(async () => {
  const { pool } = await import("../src/lib/pg.ts");
  await pool().end();
}, { skip });

type User = import("../src/lib/types.ts").User;

async function lib() {
  return {
    pg: await import("../src/lib/pg.ts"),
    decisions: await import("../src/lib/project-decisions.ts"),
    signals: await import("../src/lib/signals.ts"),
    settings: await import("../src/lib/settings.ts"),
  };
}

let rais: User;
let lead: number;
let flagship: number;
let quiet: number;
let orphan: number;

test("fixture: people, a cluster, three projects", { skip }, async () => {
  const L = await lib();
  await L.pg.migrate();
  await L.pg.run(
    `TRUNCATE project_decisions, project_stages, project_threads, thread_entries, task_events, tasks,
             meetings, meeting_projects, kelishuvlar, partner_stage_history, partners, loyihalar, settings, users, archive, audit_log
     RESTART IDENTITY CASCADE`,
  );
  const stamp = L.pg.now();
  const mk = async (login: string, role: string, department: string | null) =>
    await L.pg.insert(
      `INSERT INTO users (login, password_hash, full_name, role, department, lang, is_active, created_at)
       VALUES (?, 'x', ?, ?, ?, 'en', 1, ?)`,
      login, `DPT ${login.slice(4)}`, role, department, stamp,
    );
  const raisId = await mk("dpt_rais", "RAIS", null);
  lead = await mk("dpt_lead", "LOYIHA_RAHBARI", "GR");
  await mk("dpt_worker", "ISHCHI", "GR");
  rais = (await L.pg.get<User>("SELECT * FROM users WHERE id = ?", raisId))!;
  const cluster = await L.pg.get<{ id: number }>("SELECT id FROM klasterlar ORDER BY position LIMIT 1");
  assert.ok(cluster, "the clusters are seeded by the schema");

  // A flagship with a lead, in a cluster, reviewed weekly; created 20 days ago, never reviewed.
  flagship = await L.pg.insert(
    `INSERT INTO loyihalar (code, name, status, phase, tier, klaster_id, owner_id, deputy_id, ppp_state, ppp_public, ppp_private, created_at, next_decision_on)
     VALUES ('DPT-1', 'Flagship one', 'FAOL', 'EXECUTION', 'FLAGSHIP', ?, ?, ?, 50, 30, 20, '2026-01-01 00:00:00', '2026-01-15')`,
    cluster.id, lead, raisId,
  );
  // Another flagship for the same lead, so the lead is overloaded; active yesterday.
  quiet = await L.pg.insert(
    `INSERT INTO loyihalar (code, name, status, phase, tier, klaster_id, owner_id, deputy_id, ppp_state, ppp_public, ppp_private, created_at, last_reviewed_at)
     VALUES ('DPT-2', 'Flagship two', 'FAOL', 'PREPARATION', 'FLAGSHIP', ?, ?, ?, 50, 30, 20, ?, ?)`,
    cluster.id, lead, raisId, stamp, stamp,
  );
  // A pipeline project nobody leads, without a cluster or shares.
  orphan = await L.pg.insert(
    "INSERT INTO loyihalar (code, name, status, phase, tier, created_at) VALUES ('DPT-3', 'Orphan', 'REJA', 'CONCEPT', 'PIPELINE', ?)",
    stamp,
  );
  // Open work in GR only, one of it overdue, so the other contours are starved.
  for (const [code, deadline] of [["T-1", "2026-01-01"], ["T-2", "2099-01-01"]])
    await L.pg.run(
      `INSERT INTO tasks (code, title, from_user_id, to_user_id, to_department, priority, status, deadline, loyiha_id, created_at, kind, scope)
       VALUES (?, 'work', ?, ?, 'GR', 'ORTA', 'QABUL_QILINDI', ?, ?, ?, 'MUDDATLI', 'HAFTALIK')`,
      code, raisId, lead, deadline, flagship, stamp,
    );
});

test("health: quiet, undecided, overloaded, leaderless and starved, each named", { skip }, async () => {
  const L = await lib();
  const health = await L.signals.projectHealth(rais);
  const byCode = Object.fromEntries(health.map((p) => [p.code, p]));
  assert.equal(byCode["DPT-1"].flags.inactive, false, "the task events today count as activity");
  assert.equal(byCode["DPT-1"].flags.decisionOverdue, true);
  assert.equal(byCode["DPT-1"].flags.reviewOverdue, true, "a flagship created in January and never reviewed");
  assert.equal(byCode["DPT-1"].flags.red, true, "one of two open tasks is overdue");
  assert.equal(byCode["DPT-1"].rag, "RED");
  assert.equal(byCode["DPT-2"].rag, "GREEN");
  assert.equal(byCode["DPT-3"].flags.noOwner, true);
  assert.equal(byCode["DPT-3"].flags.passportIncomplete, true);
  assert.equal(byCode["DPT-3"].rag, "RED");

  const s = await L.signals.signals(rais, health);
  assert.deepEqual(s.overloaded.map((l) => l.projects.length), [2]);
  assert.deepEqual(s.incompletePassports.map((p) => p.code), ["DPT-3"]);
  assert.equal(s.kontur.find((k) => k.department === "GR")?.share, 100);
  assert.equal(s.kontur.find((k) => k.department === "BR")?.low, true);
  assert.equal(s.kontur.find((k) => k.department === "AI_LAB")?.low, false);

  const clusters = await L.signals.clusterHealth(health);
  const first = clusters[0];
  assert.equal(first.total, 2);
  assert.equal(first.red, 1);
  assert.equal(first.alarm, true, "one red flagship of two is over the 15% limit");
  const none = clusters.find((c) => c.id === null);
  assert.equal(none?.total, 1, "the orphan sits in the unassigned bucket");

  const needs = L.signals.interventions(health).map((p) => p.code);
  assert.deepEqual(needs.sort(), ["DPT-1", "DPT-3"]);
  const upcoming = L.signals.upcomingDecisions(health, 14);
  assert.ok(upcoming.some((p) => p.code === "DPT-1" && p.overdue));
});

test("a decision moves the phase and resets the rhythm; the passport cannot skip it", { skip }, async () => {
  const L = await lib();
  const moved = await L.decisions.recordDecision(flagship, { outcome: "CONTINUE", note: "go" }, rais.id);
  assert.equal(moved.phase, "MONITORING");
  const row = await L.pg.get<{ phase: string; status: string; next_decision_on: string; last_reviewed_at: string }>(
    "SELECT phase, status, next_decision_on, last_reviewed_at FROM loyihalar WHERE id = ?",
    flagship,
  );
  assert.equal(row?.phase, "MONITORING");
  assert.equal(row?.status, "YAKUNLANMOQDA", "the older status follows the phase");
  assert.ok(row?.last_reviewed_at);
  assert.equal(row?.next_decision_on, moved.next_decision_on);

  const stopped = await L.decisions.recordDecision(orphan, { outcome: "STOP", note: "no lead" }, rais.id);
  assert.equal(stopped.phase, "FROZEN");
  const reworked = await L.decisions.recordDecision(quiet, { outcome: "REWORK" }, rais.id);
  assert.equal(reworked.phase, "PREPARATION");

  const history = await L.decisions.decisionsOf(flagship);
  assert.equal(history.length, 1);
  assert.equal(history[0].phase_from, "EXECUTION");
  assert.equal(history[0].outcome, "CONTINUE");
  assert.equal(history[0].decided_by_name, "DPT rais");

  // After the decisions the flagship reads green and the frozen one is off the board.
  const health = await L.signals.projectHealth(rais);
  const byCode = Object.fromEntries(health.map((p) => [p.code, p]));
  assert.equal(byCode["DPT-1"].flags.decisionOverdue, false);
  assert.equal(byCode["DPT-1"].flags.reviewOverdue, false);
  assert.equal(byCode["DPT-3"].live, false);
  assert.equal(byCode["DPT-3"].rag, "GREEN");
  assert.deepEqual(L.signals.interventions(health).map((p) => p.code), ["DPT-1"], "still red: an overdue task");

  // The tier's rhythm from settings: a 3-day flagship review.
  await L.settings.writeSetting(L.settings.TIER_SETTINGS_KEY, { FLAGSHIP: { reviewDays: 3 } }, rais.id);
  const next = await L.decisions.markReviewed(flagship);
  const today = L.pg.now().slice(0, 10);
  const { addDaysTo } = await import("../src/lib/signal-rules.ts");
  assert.equal(next, addDaysTo(today, 3));
});

test("the period's results count signed agreements, money and new partners", { skip }, async () => {
  const L = await lib();
  const stamp = L.pg.now();
  const today = stamp.slice(0, 10);
  await L.pg.run(
    "INSERT INTO kelishuvlar (title, kind, amount, currency, signed_on, status, created_by, created_at, updated_at) VALUES ('MOU', 'MOU', 1500000, 'USD', ?, 'OPEN', ?, ?, ?)",
    today, rais.id, stamp, stamp,
  );
  const partner = await L.pg.insert(
    "INSERT INTO partners (name, status, stage, stage_since, created_at, updated_at) VALUES ('New Co', 'ACTIVE', 'ACTIVE', ?, ?, ?)",
    stamp, stamp, stamp,
  );
  await L.pg.run(
    "INSERT INTO partner_stage_history (partner_id, from_stage, to_stage, reason, changed_at) VALUES (?, 'AGREEMENT', 'ACTIVE', 'contract', ?)",
    partner, stamp,
  );
  const results = await L.signals.periodResults(today.slice(0, 8) + "01", today);
  assert.equal(results.agreements, 1);
  assert.deepEqual(results.amounts, [{ currency: "USD", amount: 1500000 }]);
  assert.equal(results.newPartners, 1);
  assert.equal(results.newCompanies, 1);
});
