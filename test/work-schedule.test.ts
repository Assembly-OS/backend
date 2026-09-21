import { test } from "node:test";
import assert from "node:assert/strict";
import { daysLate, isLate, stageView, type StageDates } from "../src/lib/work-schedule.ts";

const TODAY = "2026-09-18";
const stage = (patch: Partial<StageDates>): StageDates => ({
  plan_start: "2026-09-01",
  plan_end: "2026-09-10",
  fact_start: null,
  fact_end: null,
  progress: 0,
  ...patch,
});

test("unfinished and past its planned end is late", () => {
  const s = stage({ fact_start: "2026-09-02", progress: 60 });
  assert.equal(isLate(s, TODAY), true);
  assert.equal(daysLate(s, TODAY), 8);
  assert.equal(stageView(s, TODAY), "LATE");
});

test("finished after the plan is late, and finished", () => {
  // The reason for the delay is still owed; the item is still done.
  const s = stage({ fact_start: "2026-09-01", fact_end: "2026-09-13", progress: 100 });
  assert.equal(isLate(s, TODAY), true);
  assert.equal(daysLate(s, TODAY), 3);
  assert.equal(stageView(s, TODAY), "DONE");
});

test("finished on the planned day is not late", () => {
  const s = stage({ fact_end: "2026-09-10", progress: 100 });
  assert.equal(isLate(s, TODAY), false);
  assert.equal(daysLate(s, TODAY), 0);
});

test("a late start made up by the end is not a delay", () => {
  const s = stage({ fact_start: "2026-09-05", fact_end: "2026-09-09", progress: 100 });
  assert.equal(isLate(s, TODAY), false);
});

test("the last planned day itself is not yet late", () => {
  assert.equal(isLate(stage({ plan_end: TODAY, progress: 40 }), TODAY), false);
});

test("a hundred per cent without an end date is done, not late", () => {
  const s = stage({ progress: 100 });
  assert.equal(isLate(s, TODAY), false);
  assert.equal(stageView(s, TODAY), "DONE");
});

test("an item ahead of us is planned, one under way is active", () => {
  assert.equal(stageView(stage({ plan_start: "2026-10-01", plan_end: "2026-10-20" }), TODAY), "PLANNED");
  assert.equal(stageView(stage({ plan_start: "2026-09-15", plan_end: "2026-10-20" }), TODAY), "ACTIVE");
});
