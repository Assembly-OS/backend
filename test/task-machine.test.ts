import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeTransition, type TaskContext } from "../src/lib/task-machine.ts";

const AUTHOR = 1;
const ASSIGNEE = 2;
const STRANGER = 3;

const task = (status: string, over: Partial<TaskContext> = {}): TaskContext => ({
  status: status as TaskContext["status"],
  from_user_id: AUTHOR,
  to_user_id: ASSIGNEE,
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
