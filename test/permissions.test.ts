import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITIES,
  COLUMNS,
  PERMISSIONS,
  columnOf,
  columnFor,
  may,
  reach,
} from "../src/lib/permissions.ts";
import { ROLES, isExternal, receivesTasks, isManager } from "../src/lib/types.ts";

const person = (role: (typeof ROLES)[number], login = "someone") => ({ role, login });

test("every capability has a reach for every column of TZ 4.2", () => {
  for (const capability of CAPABILITIES)
    for (const column of COLUMNS)
      assert.ok(PERMISSIONS[capability][column], `${capability} × ${column}`);
});

test("every role reads exactly one column", () => {
  for (const role of ROLES) assert.ok(COLUMNS.includes(columnOf(role)), role);
});

test("project visibility is the TZ's row", () => {
  assert.equal(reach(person("RAIS"), "viewProjects"), "yes");
  assert.equal(reach(person("BOLIM_RAHBARI"), "viewProjects"), "department");
  assert.equal(reach(person("KLASTER_RAHBARI"), "viewProjects"), "cluster");
  assert.equal(reach(person("LOYIHA_RAHBARI"), "viewProjects"), "own");
  assert.equal(reach(person("ISHCHI"), "viewProjects"), "attached");
  assert.equal(reach(person("TASHQI_LOYIHA_RAHBARI"), "viewProjects"), "own");
  assert.equal(reach(person("UYUSHMA_VAKILI"), "viewProjects"), "no");
  assert.equal(reach(person("UYUSHMA_RAISI"), "viewProjects"), "no");
});

test("the chairman's assistant reads the chairman's column", () => {
  // The default assistant login from lib/oversight.ts.
  assert.equal(columnFor(person("BOLIM_RAHBARI", "muslimbek.komiljonov")), "RAIS");
  assert.equal(columnFor(person("BOLIM_RAHBARI", "someone.else")), "BOLIM");
});

test("nobody outside the Assembly gives or takes work, or sees staff KPIs", () => {
  for (const role of ["TASHQI_LOYIHA_RAHBARI", "UYUSHMA_RAISI", "UYUSHMA_VAKILI"] as const) {
    assert.ok(isExternal(role));
    assert.equal(receivesTasks(role), false);
    assert.equal(isManager(role), false);
    assert.equal(may(person(role), "assignTasks"), false);
    assert.equal(may(person(role), "viewOthersKpi"), false);
    assert.equal(may(person(role), "globalAi"), false);
  }
});

test("the outside project lead enters stage status on his own project only", () => {
  assert.equal(reach(person("TASHQI_LOYIHA_RAHBARI"), "enterStageStatus"), "own");
  assert.equal(may(person("TASHQI_LOYIHA_RAHBARI"), "editPassport"), false);
});

test("the global AI view is a grant for department heads, never a role default", () => {
  assert.equal(reach(person("BOLIM_RAHBARI"), "globalAi"), "grant");
  assert.equal(reach(person("RAIS"), "globalAi"), "yes");
  assert.equal(may(person("ISHCHI"), "globalAi"), false);
});
