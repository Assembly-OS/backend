import { test, before, after } from "node:test";
import assert from "node:assert/strict";

/**
 * The partnership path and the associations against a real Postgres
 * (TZ 6.1, 6.2). Runs only when TEST_DATABASE_URL (or the knowledge test's
 * KNOWLEDGE_TEST_DATABASE_URL) names a scratch database: the schema is
 * applied to it and the tables the test touches are emptied.
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
    crm: await import("../src/lib/crm.ts"),
    stages: await import("../src/lib/crm-stages.ts"),
    assoc: await import("../src/lib/associations.ts"),
    settings: await import("../src/lib/settings.ts"),
  };
}

let rais: User;
let head: User;
let chair: User;
let lead: User;
let projectId: number;
let companyId: number;

test("fixture: schema, four people, a project", { skip }, async () => {
  const L = await lib();
  await L.pg.migrate();
  await L.pg.run(
    `TRUNCATE partner_stage_history, uyushma_projects, partners, uyushmalar, meetings, agreements,
             project_threads, project_members, loyihalar, settings, users, archive, audit_log
     RESTART IDENTITY CASCADE`,
  );
  const stamp = L.pg.now();
  const mk = async (login: string, role: string, department: string | null, uyushma: number | null) =>
    await L.pg.insert(
      `INSERT INTO users (login, password_hash, full_name, role, department, uyushma_id, lang, is_active, created_at)
       VALUES (?, 'x', ?, ?, ?, ?, 'en', 1, ?)`,
      login, `CPT ${login.slice(4)}`, role, department, uyushma, stamp,
    );
  const raisId = await mk("cpt_rais", "RAIS", null, null);
  const headId = await mk("cpt_head", "BOLIM_RAHBARI", "BR", null);
  await mk("cpt_lead", "TASHQI_LOYIHA_RAHBARI", null, null);
  projectId = await L.pg.insert(
    "INSERT INTO loyihalar (code, name, status, owner_id, created_at) VALUES ('CPT-1', 'Cement plant', 'FAOL', ?, ?)",
    headId, stamp,
  );
  const get = async (login: string) => {
    const row = await L.pg.get<User>("SELECT * FROM users WHERE login = ?", login);
    assert.ok(row, login);
    return row;
  };
  rais = await get("cpt_rais");
  head = await get("cpt_head");
  lead = await get("cpt_lead");
  assert.equal(rais.id, raisId);
});

test("an association: created by the staff, seen by its own people only", { skip }, async () => {
  const L = await lib();
  const id = await L.assoc.createAssociation(
    { name: "Cement Makers Association", sector: "Construction", kontur: "BR", head_name: "A. Head", project_ids: [projectId] },
    head,
  );
  const other = await L.assoc.createAssociation({ name: "Another Association", sector: "Food" }, head);
  // The association's chairman, attached to the first one.
  await L.pg.run(
    "INSERT INTO users (login, password_hash, full_name, role, uyushma_id, lang, is_active, created_at) VALUES ('cpt_chair', 'x', 'CPT chair', 'UYUSHMA_RAISI', ?, 'en', 1, ?)",
    id, L.pg.now(),
  );
  chair = (await L.pg.get<User>("SELECT * FROM users WHERE login = 'cpt_chair'"))!;

  assert.deepEqual((await L.assoc.associations(rais)).map((a) => a.id).sort(), [id, other].sort());
  assert.deepEqual((await L.assoc.associations(chair)).map((a) => a.id), [id]);
  assert.equal(await L.assoc.associationById(chair, other), undefined);
  assert.deepEqual(await L.assoc.associations(lead), []);

  const card = await L.assoc.associationCard(head, id);
  assert.ok(card);
  assert.equal(card.projects, 1);
  assert.equal(card.projectList[0].code, "CPT-1");
  assert.equal(card.short_name, "Cement Makers Association");

  await L.assoc.updateAssociation(id, { status: "SUST", project_ids: [] }, head);
  const after = await L.assoc.associationById(head, id);
  assert.equal(after?.status, "SUST");
  assert.equal(after?.projects, 0);
});

test("import: the reference list as CSV, existing names updated", { skip }, async () => {
  const L = await lib();
  const parsed = L.assoc.parseAssociationCsv(
    "name;sector;kontur;region;head_name;members_count;status\nCement Makers Association;Construction;GR;Navoiy;B. Head;40;FAOL\nNew One;IT;XX;;;;\n;;;\n",
  );
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.rows[1].kontur, null);
  const result = await L.assoc.importAssociations(parsed.rows, rais);
  assert.deepEqual(result, { created: 1, updated: 1 });
  const rows = await L.assoc.associations(rais);
  const cement = rows.find((a) => a.name === "Cement Makers Association");
  assert.equal(cement?.kontur, "GR");
  assert.equal(cement?.members_count, 40);
  assert.equal(cement?.head_name, "B. Head");
  assert.equal(L.assoc.parseAssociationCsv("").errors[0], "EMPTY");
  assert.equal(L.assoc.parseAssociationCsv("a,b\n1,2").errors[0], "HEADER");
});

test("the path: a new company starts at NEW_CONTACT, events lift it, never lower it", { skip }, async () => {
  const L = await lib();
  const cement = (await L.assoc.associations(rais)).find((a) => a.name === "Cement Makers Association")!;
  companyId = await L.crm.createCompany({ name: "Navoiy Cement", status: "POTENTIAL", owner_user_id: head.id, uyushma_id: cement.id });
  let row = await L.crm.companyById(companyId);
  assert.equal(row?.stage, "NEW_CONTACT");
  assert.equal(row?.status, "POTENTIAL");
  assert.equal(row?.uyushma_name, "Cement Makers Association");
  assert.equal((await L.crm.stageHistory(companyId)).length, 1, "the birth is written down");

  // A meeting lifts it to MEETING; a second meeting changes nothing.
  assert.equal(await L.crm.advanceStage(companyId, "meeting", head.id, "first"), true);
  assert.equal(await L.crm.advanceStage(companyId, "meeting", head.id, "second"), false);
  row = await L.crm.companyById(companyId);
  assert.equal(row?.stage, "MEETING");

  // By hand to NEGOTIATION, then a signed memorandum to AGREEMENT, a contract to ACTIVE.
  assert.equal(await L.crm.moveStage(companyId, "NEGOTIATION", head.id, { note: "price" }), true);
  assert.equal(await L.crm.advanceStage(companyId, "kelishuv", head.id), true);
  assert.equal(await L.crm.advanceStage(companyId, "contract", head.id), true);
  row = await L.crm.companyById(companyId);
  assert.equal(row?.stage, "ACTIVE");
  assert.equal(row?.status, "ACTIVE", "the old status follows the stage");

  // A recorded meeting never pulls an active partner back.
  assert.equal(await L.crm.advanceStage(companyId, "meeting", head.id), false);
  // The card may: a partnership that reopens its negotiation is a fact.
  assert.equal(await L.crm.moveStage(companyId, "NEGOTIATION", rais.id), true);
  assert.equal((await L.crm.companyById(companyId))?.status, "POTENTIAL");

  const history = await L.crm.stageHistory(companyId);
  assert.deepEqual(
    history.map((h) => [h.from_stage, h.to_stage, h.reason]),
    [
      ["ACTIVE", "NEGOTIATION", "manual"],
      ["AGREEMENT", "ACTIVE", "contract"],
      ["NEGOTIATION", "AGREEMENT", "kelishuv"],
      ["MEETING", "NEGOTIATION", "manual"],
      ["NEW_CONTACT", "MEETING", "meeting"],
      [null, "NEW_CONTACT", "manual"],
    ],
  );
  assert.equal(history[0].changed_by_name, "CPT rais");
  assert.equal(history[3].note, "price");

  const funnel = await L.crm.funnel();
  assert.equal(funnel.NEGOTIATION, 1);
  const card = await L.assoc.associationCard(rais, cement.id);
  assert.equal(card?.companies, 1);
  assert.equal(card?.companyList[0].stage, "NEGOTIATION");
});

test("stuck: past the stage's limit, with the limits from settings", { skip }, async () => {
  const L = await lib();
  assert.deepEqual(await L.settings.stageLimits(), L.stages.DEFAULT_STAGE_LIMITS);
  await L.settings.writeSetting(L.settings.CRM_SETTINGS_KEY, { stageLimits: { NEGOTIATION: 10, CLOSED: 0, MEETING: -1 } }, rais.id);
  const limits = await L.settings.stageLimits();
  assert.equal(limits.NEGOTIATION, 10);
  assert.equal(limits.MEETING, 30, "a bad number keeps the default");

  assert.deepEqual(await L.crm.stuckCompanies(limits), []);
  // Backdate the stay by two weeks.
  await L.pg.run("UPDATE partners SET stage_since = ? WHERE id = ?", "2026-01-01 00:00:00", companyId);
  const stuck = await L.crm.stuckCompanies(limits);
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].id, companyId);
  assert.ok(stuck[0].days > 10);
  // A closed company never reads as stuck.
  await L.crm.moveStage(companyId, "CLOSED", rais.id);
  await L.pg.run("UPDATE partners SET stage_since = ? WHERE id = ?", "2026-01-01 00:00:00", companyId);
  assert.deepEqual(await L.crm.stuckCompanies(limits), []);
});
