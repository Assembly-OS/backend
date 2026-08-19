import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approverOf,
  authorizeTransition,
  type TaskContext,
} from "../src/lib/task-machine.ts";

const AUTHOR = 1;
const ASSIGNEE = 2;
const STRANGER = 3;
/** The person holding the second turn of a chain. */
const SECOND = 4;

// The chain fields default to what a plain assignment looks like — one stage,
// approved by its author — so every test written before chains existed keeps
// asserting exactly what it always did.
const task = (status: string, over: Partial<TaskContext> = {}): TaskContext => ({
  status: status as TaskContext["status"],
  from_user_id: AUTHOR,
  to_user_id: ASSIGNEE,
  current_stage: 1,
  stage_count: 1,
  reviewer_user_id: null,
  ...over,
});

test("assignee accepts a new task", () => {
  assert.deepEqual(authorizeTransition("accept", task("YANGI"), ASSIGNEE), {
    ok: true,
    to: "QABUL_QILINDI",
    event: "QABUL_QILINDI",
    actor: "assignee",
  });
});

test("unknown action is BAD_ACTION", () => {
  assert.deepEqual(authorizeTransition("frobnicate", task("YANGI"), ASSIGNEE), {
    ok: false,
    error: "BAD_ACTION",
  });
});

test("author cannot accept — wrong actor", () => {
  assert.deepEqual(authorizeTransition("accept", task("YANGI"), AUTHOR), {
    ok: false,
    error: "FORBIDDEN",
  });
});

test("a stranger cannot act on the task", () => {
  assert.equal(authorizeTransition("accept", task("YANGI"), STRANGER).ok, false);
});

test("accepting from a non-YANGI status is BAD_STATE", () => {
  assert.deepEqual(
    authorizeTransition("accept", task("BAJARILMOQDA"), ASSIGNEE),
    { ok: false, error: "BAD_STATE" },
  );
});

test("author approves a task under review", () => {
  const result = authorizeTransition("approve", task("TEKSHIRUVDA"), AUTHOR);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.to, "BAJARILDI");
});

test("assignee cannot approve — that is the author's move", () => {
  assert.deepEqual(
    authorizeTransition("approve", task("TEKSHIRUVDA"), ASSIGNEE),
    { ok: false, error: "FORBIDDEN" },
  );
});

test("submit is allowed from every in-progress status", () => {
  for (const status of ["QABUL_QILINDI", "BAJARILMOQDA", "QAYTARILDI"]) {
    assert.equal(
      authorizeTransition("submit", task(status), ASSIGNEE).ok,
      true,
      `submit should be allowed from ${status}`,
    );
  }
});

test("author returns a reviewed task for rework", () => {
  const result = authorizeTransition("return", task("TEKSHIRUVDA"), AUTHOR);
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.to, "QAYTARILDI");
});

/* ------------------------------------------------------------------ */
/* Chains — a task that several people hold in turn                    */
/* ------------------------------------------------------------------ */

test("approving the last stage closes the task", () => {
  assert.deepEqual(
    authorizeTransition(
      "approve",
      task("TEKSHIRUVDA", { current_stage: 3, stage_count: 3 }),
      AUTHOR,
    ),
    { ok: true, to: "BAJARILDI", event: "TASDIQLANDI", actor: "author" },
  );
});

test("approving a middle stage hands the task on instead of closing it", () => {
  assert.deepEqual(
    authorizeTransition(
      "approve",
      task("TEKSHIRUVDA", { current_stage: 1, stage_count: 3 }),
      AUTHOR,
    ),
    {
      ok: true,
      to: "YANGI",
      event: "BOSQICH_TASDIQLANDI",
      actor: "author",
      advance: true,
    },
  );
});

test("a one-stage task never advances", () => {
  const result = authorizeTransition("approve", task("TEKSHIRUVDA"), AUTHOR);
  assert.equal(result.ok && result.advance, undefined);
});

test("the stage reviewer approves instead of the author", () => {
  const result = authorizeTransition(
    "approve",
    task("TEKSHIRUVDA", {
      current_stage: 1,
      stage_count: 2,
      reviewer_user_id: SECOND,
    }),
    SECOND,
  );
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.to, "YANGI");
  assert.equal(result.ok && result.advance, true);
});

test("the author cannot approve a stage whose reviewer is somebody else", () => {
  assert.deepEqual(
    authorizeTransition(
      "approve",
      task("TEKSHIRUVDA", {
        current_stage: 1,
        stage_count: 2,
        reviewer_user_id: SECOND,
      }),
      AUTHOR,
    ),
    { ok: false, error: "FORBIDDEN" },
  );
});

test("the stage reviewer may return the work to its own executor", () => {
  // `current_stage` does not move: the stage stays current until it is
  // approved, so the rework lands back on the person who did it. Keeping the
  // pointer still is the route's job, not the machine's — here it is simply
  // never told to change.
  const result = authorizeTransition(
    "return",
    task("TEKSHIRUVDA", {
      current_stage: 1,
      stage_count: 2,
      reviewer_user_id: SECOND,
    }),
    SECOND,
  );
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.to, "QAYTARILDI");
});

test("the mid-chain assignee still accepts and rejects normally", () => {
  const middle = { current_stage: 2, stage_count: 3 };
  assert.equal(
    authorizeTransition("accept", task("YANGI", middle), ASSIGNEE).ok &&
      authorizeTransition("accept", task("YANGI", middle), ASSIGNEE).to,
    "QABUL_QILINDI",
  );
  assert.equal(
    authorizeTransition("reject", task("YANGI", middle), ASSIGNEE).ok &&
      authorizeTransition("reject", task("YANGI", middle), ASSIGNEE).to,
    "RAD_ETILDI",
  );
});

test("approverOf falls back to the author", () => {
  assert.equal(approverOf(task("YANGI")), AUTHOR);
  assert.equal(
    approverOf(task("YANGI", { reviewer_user_id: SECOND })),
    SECOND,
  );
});
