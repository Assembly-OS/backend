import { test } from "node:test";
import assert from "node:assert/strict";
import {
  daysIn,
  DEFAULT_STAGE_LIMITS,
  isAdvance,
  isStuck,
  mergeStageLimits,
  STAGES,
  stageFor,
  stageFromStatus,
  statusFromStage,
} from "../src/lib/crm-stages.ts";

test("the path has the TZ's nine stages in order", () => {
  assert.equal(STAGES.length, 9);
  assert.equal(STAGES[0], "NEW_CONTACT");
  assert.equal(STAGES[5], "AGREEMENT");
  assert.equal(STAGES[8], "CLOSED");
});

test("old statuses map onto the path and back", () => {
  assert.equal(stageFromStatus("ACTIVE"), "ACTIVE");
  assert.equal(stageFromStatus("ARCHIVED"), "CLOSED");
  assert.equal(stageFromStatus("POTENTIAL"), "NEW_CONTACT");
  assert.equal(statusFromStage("MONITORING"), "ACTIVE");
  assert.equal(statusFromStage("PROPOSAL"), "POTENTIAL");
  assert.equal(statusFromStage("CLOSED"), "ARCHIVED");
});

test("records earn stages: a meeting, a signed agreement, a contract", () => {
  assert.equal(stageFor("meeting"), "MEETING");
  assert.equal(stageFor("kelishuv"), "AGREEMENT");
  assert.equal(stageFor("contract"), "ACTIVE");
  assert.ok(isAdvance("CONTACT", "MEETING"));
  assert.ok(!isAdvance("AGREEMENT", "MEETING"));
});

test("a company is stuck past its stage's limit, never in CLOSED", () => {
  const today = new Date("2026-11-14T12:00:00Z");
  assert.equal(daysIn("2026-11-01 10:00:00", today), 13);
  assert.ok(!isStuck("NEW_CONTACT", "2026-11-01 10:00:00", DEFAULT_STAGE_LIMITS, today));
  assert.ok(isStuck("NEW_CONTACT", "2026-10-01 10:00:00", DEFAULT_STAGE_LIMITS, today));
  assert.ok(!isStuck("CLOSED", "2020-01-01 00:00:00", DEFAULT_STAGE_LIMITS, today));
  assert.ok(!isStuck("CONTACT", null, DEFAULT_STAGE_LIMITS, today));
});

test("stored limits override the defaults and bad values are ignored", () => {
  const merged = mergeStageLimits({ NEW_CONTACT: 7, CONTACT: -1, PROPOSAL: "x", CLOSED: 30 });
  assert.equal(merged.NEW_CONTACT, 7);
  assert.equal(merged.CONTACT, DEFAULT_STAGE_LIMITS.CONTACT);
  assert.equal(merged.PROPOSAL, DEFAULT_STAGE_LIMITS.PROPOSAL);
  assert.equal(merged.CLOSED, 30);
});
