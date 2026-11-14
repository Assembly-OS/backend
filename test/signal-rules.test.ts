import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AI_DEFAULTS,
  SIGNAL_DEFAULTS,
  TIER_DEFAULTS,
  addDaysTo,
  autoApprovable,
  daysBetween,
  konturShares,
  mergeAiSettings,
  mergeSignalSettings,
  mergeTierSettings,
  nextPhase,
  phaseAfter,
  projectRag,
  redShareOk,
  reviewDueOn,
} from "../src/lib/signal-rules.ts";

test("settings: stored values over the defaults, bad numbers kept out", () => {
  assert.deepEqual(mergeTierSettings(null), TIER_DEFAULTS);
  const tiers = mergeTierSettings({ FLAGSHIP: { reviewDays: 5, redShareMax: 200 }, PIPELINE: "x" });
  assert.equal(tiers.FLAGSHIP.reviewDays, 5);
  assert.equal(tiers.FLAGSHIP.redShareMax, 15, "out of range keeps the default");
  assert.deepEqual(tiers.PIPELINE, TIER_DEFAULTS.PIPELINE);

  assert.deepEqual(mergeSignalSettings(undefined), SIGNAL_DEFAULTS);
  const signal = mergeSignalSettings({ inactiveDays: { ACTIVE: 10 }, konturMinShare: 5, overloadProjects: 0 });
  assert.equal(signal.inactiveDays.ACTIVE, 10);
  assert.equal(signal.inactiveDays.FLAGSHIP, 14);
  assert.equal(signal.konturMinShare, 5);
  assert.equal(signal.overloadProjects, 2, "zero is not a count");

  assert.deepEqual(mergeAiSettings({}), AI_DEFAULTS);
  const ai = mergeAiSettings({ autoApprove: true, autoApproveMaxSeverity: "P3", expireDays: 0 });
  assert.equal(ai.autoApprove, true);
  assert.equal(ai.autoApproveMaxSeverity, "P3");
  assert.equal(ai.expireDays, 30);
});

test("auto-approval: off by default; on, only at or below the risk limit", () => {
  assert.equal(autoApprovable("P4", AI_DEFAULTS), false);
  const on = mergeAiSettings({ autoApprove: true, autoApproveMaxSeverity: "P3" });
  assert.equal(autoApprovable("P4", on), true);
  assert.equal(autoApprovable("P3", on), true);
  assert.equal(autoApprovable("P2", on), false);
  assert.equal(autoApprovable("P1", on), false);
  assert.equal(autoApprovable("??", on), false);
});

test("decisions: continue walks the cycle, rework stays, stop freezes, a named phase wins", () => {
  assert.equal(nextPhase(null), "CONCEPT");
  assert.equal(nextPhase("CONCEPT"), "FEASIBILITY");
  assert.equal(nextPhase("MONITORING"), "CLOSED");
  assert.equal(nextPhase("CLOSED"), null);
  assert.equal(nextPhase("FROZEN"), null);
  assert.equal(phaseAfter("CONTINUE", "PREPARATION"), "EXECUTION");
  assert.equal(phaseAfter("REWORK", "PREPARATION"), "PREPARATION");
  assert.equal(phaseAfter("STOP", "EXECUTION"), "FROZEN");
  assert.equal(phaseAfter("CONTINUE", "FROZEN", "EXECUTION"), "EXECUTION");
  assert.equal(phaseAfter("CONTINUE", "FROZEN"), null);
});

test("calendar: review dates follow the tier's rhythm", () => {
  assert.equal(addDaysTo("2026-02-27", 3), "2026-03-02");
  assert.equal(daysBetween("2026-01-01", "2026-01-31"), 30);
  assert.equal(daysBetween("2026-01-31", "2026-01-01"), -30);
  assert.equal(reviewDueOn(null, "2026-03-01 10:00:00", "FLAGSHIP", TIER_DEFAULTS), "2026-03-08");
  assert.equal(reviewDueOn("2026-03-10 09:00:00", "2026-01-01", "ACTIVE", TIER_DEFAULTS), "2026-04-09");
  assert.equal(reviewDueOn(null, "2026-01-01", null, TIER_DEFAULTS), "2026-04-01", "no tier reads as pipeline");
});

test("health: red is what needs the chairman, amber is drift, green stays off the screen", () => {
  const quiet = { inactive: false, decisionOverdue: false, reviewOverdue: false, red: false, noOwner: false, passportIncomplete: false };
  assert.equal(projectRag(quiet), "GREEN");
  assert.equal(projectRag({ ...quiet, inactive: true }), "AMBER");
  assert.equal(projectRag({ ...quiet, passportIncomplete: true }), "AMBER");
  assert.equal(projectRag({ ...quiet, inactive: true, noOwner: true }), "RED");
  assert.equal(projectRag({ ...quiet, decisionOverdue: true }), "RED");
  assert.equal(redShareOk(1, 10, "FLAGSHIP", TIER_DEFAULTS), true);
  assert.equal(redShareOk(2, 10, "FLAGSHIP", TIER_DEFAULTS), false);
  assert.equal(redShareOk(9, 10, "PIPELINE", TIER_DEFAULTS), true, "red is normal in the pipeline");
  assert.equal(redShareOk(0, 0, "FLAGSHIP", TIER_DEFAULTS), true);
});

test("contours: shares over every department, the alarm for the starved contours only", () => {
  const shares = konturShares({ AI_LAB: 49, PR: 34, GR: 12, FR: 3, BR: 2 }, ["GR", "FR", "BR", "PR", "AI_LAB"], 10, ["GR", "FR", "BR", "PR"]);
  const by = Object.fromEntries(shares.map((s) => [s.department, s]));
  assert.equal(by.AI_LAB.share, 49);
  assert.equal(by.BR.share, 2);
  assert.equal(by.BR.low, true);
  assert.equal(by.FR.low, true);
  assert.equal(by.GR.low, false);
  assert.equal(by.AI_LAB.low, false, "AI Lab is not a contour");
  assert.ok(konturShares({}, ["GR"], 10).every((s) => !s.low), "nothing open: nothing starved");
});
