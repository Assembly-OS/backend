import { test } from "node:test";
import assert from "node:assert/strict";
import {
  combine,
  DEFAULT_SETTINGS,
  fractionPercent,
  kpiBounds,
  meanScore,
  mergeSettings,
  ragOf,
  scaleTargets,
  scoreAction,
  scoreResult,
} from "../src/lib/kpi-rules.ts";

test("the TZ's ratios are the defaults and every role has one", () => {
  assert.deepEqual(DEFAULT_SETTINGS.ratios.ISHCHI, { action: 70, result: 30 });
  assert.deepEqual(DEFAULT_SETTINGS.ratios.BOLIM_RAHBARI, { action: 50, result: 50 });
  assert.deepEqual(DEFAULT_SETTINGS.ratios.LOYIHA_RAHBARI, { action: 40, result: 60 });
  assert.deepEqual(DEFAULT_SETTINGS.ratios.KLASTER_RAHBARI, { action: 30, result: 70 });
  for (const ratio of Object.values(DEFAULT_SETTINGS.ratios)) assert.equal(ratio.action + ratio.result, 100);
});

test("a component with nothing counted does not apply", () => {
  assert.equal(fractionPercent({ good: 0, total: 0 }), null);
  assert.equal(fractionPercent({ good: 3, total: 4 }), 75);
});

test("effort is the mean of the components that apply", () => {
  const none = { good: 0, total: 0 };
  assert.equal(
    scoreAction({ onTime: { good: 1, total: 2 }, reporting: none, rework: { good: 4, total: 4 }, meetings: none }),
    75,
  );
  assert.equal(scoreAction({ onTime: none, reporting: none, rework: none, meetings: none }), null);
});

test("result is actual over target, capped, averaged with open-ended goals", () => {
  const targets = { agreements: 2, obligations: 0, partners: 1, phases: 0, contracts: 0 };
  const actuals = { agreements: 1, obligations: 9, partners: 3, phases: 0, contracts: 0 };
  // 1/2 and min(1, 3/1) → (0.5 + 1) / 2
  assert.equal(scoreResult(actuals, targets, []), 75);
  // A goal at 40% joins the mean: (0.5 + 1 + 0.4) / 3
  assert.equal(
    scoreResult(actuals, targets, [{ taskId: 1, code: "T-1", title: "x", target: 10, latest: 4, unit: null }]),
    63,
  );
  // No targets, no goals: the question does not arise.
  assert.equal(scoreResult(actuals, { agreements: 0, obligations: 0, partners: 0, phases: 0, contracts: 0 }, []), null);
});

test("the ratio weighs the two halves; a missing half leaves the other", () => {
  assert.equal(combine(80, 40, { action: 70, result: 30 }), 68);
  assert.equal(combine(80, null, { action: 70, result: 30 }), 80);
  assert.equal(combine(null, 40, { action: 70, result: 30 }), 40);
  assert.equal(combine(null, null, { action: 70, result: 30 }), null);
});

test("the traffic light follows the TZ's thresholds", () => {
  const rag = DEFAULT_SETTINGS.rag;
  assert.equal(ragOf(80, rag), "GREEN");
  assert.equal(ragOf(79, rag), "AMBER");
  assert.equal(ragOf(60, rag), "AMBER");
  assert.equal(ragOf(59, rag), "RED");
  assert.equal(ragOf(null, rag), null);
  assert.equal(meanScore([80, null, 60]), 70);
  assert.equal(meanScore([null]), null);
});

test("stored settings override the defaults, and bad values cannot break them", () => {
  const merged = mergeSettings({
    ratios: { ISHCHI: { action: 60 }, LOYIHA_RAHBARI: { action: 140 } },
    rag: { green: 85, amber: 90 },
    limits: { lateShare: -5 },
    targets: { ISHCHI: { partners: 4, agreements: "x" } },
  });
  assert.deepEqual(merged.ratios.ISHCHI, { action: 60, result: 40 });
  assert.deepEqual(merged.ratios.LOYIHA_RAHBARI, DEFAULT_SETTINGS.ratios.LOYIHA_RAHBARI);
  assert.equal(merged.rag.green, 85);
  assert.equal(merged.rag.amber, 85, "amber cannot sit above green");
  assert.equal(merged.limits.lateShare, DEFAULT_SETTINGS.limits.lateShare);
  assert.equal(merged.targets.ISHCHI.partners, 4);
  assert.equal(merged.targets.ISHCHI.agreements, DEFAULT_SETTINGS.targets.ISHCHI.agreements);
  assert.deepEqual(mergeSettings(null), DEFAULT_SETTINGS);
});

test("periods are calendar months and quarters, and targets scale with them", () => {
  const now = new Date(2026, 10, 14, 12); // 14 November 2026
  const month = kpiBounds("month", 0, now);
  assert.equal(month.fromDay, "2026-11-01");
  assert.equal(month.toDay, "2026-11-30");
  assert.equal(month.months, 1);
  const previous = kpiBounds("month", -1, now);
  assert.equal(previous.fromDay, "2026-10-01");
  assert.equal(previous.toDay, "2026-10-31");
  const quarter = kpiBounds("quarter", 0, now);
  assert.equal(quarter.fromDay, "2026-10-01");
  assert.equal(quarter.toDay, "2026-12-31");
  assert.equal(quarter.months, 3);
  assert.ok(month.from < month.to);
  // The current month is 14 days in: a little under half elapsed.
  assert.ok(month.elapsed > 0.4 && month.elapsed < 0.5, String(month.elapsed));
  assert.equal(previous.elapsed, 1);
  assert.equal(scaleTargets({ agreements: 1, obligations: 2, partners: 0, phases: 1, contracts: 0 }, 3).obligations, 6);
  assert.equal(scaleTargets({ agreements: 2, obligations: 0, partners: 0, phases: 0, contracts: 0 }, 1, 0.45).agreements, 0.9);
});
