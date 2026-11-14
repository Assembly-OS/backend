import { test } from "node:test";
import assert from "node:assert/strict";
import { priorityRefusal } from "../src/lib/priority-rules.ts";

const room = (kritikOpen: number, authorOpen: number, authorHigh: number) => ({
  kritikOpen,
  authorOpen,
  authorHigh,
});

test("a sixth open critical assignment is refused, a fifth is not", () => {
  assert.equal(priorityRefusal("KRITIK", room(4, 0, 0)), null);
  assert.equal(priorityRefusal("KRITIK", room(5, 0, 0)), "KRITIK_LIMIT");
});

test("a manager's first high assignment is always allowed", () => {
  assert.equal(priorityRefusal("YUQORI", room(0, 0, 0)), null);
  assert.equal(priorityRefusal("YUQORI", room(0, 3, 0)), null);
});

test("high is capped at a quarter of the author's open work, new one included", () => {
  // 7 open + 1 new = 8; a quarter is 2.
  assert.equal(priorityRefusal("YUQORI", room(0, 7, 1)), null);
  assert.equal(priorityRefusal("YUQORI", room(0, 7, 2)), "YUQORI_LIMIT");
  // The audit's picture: 36 high out of 58 open.
  assert.equal(priorityRefusal("YUQORI", room(0, 58, 36)), "YUQORI_LIMIT");
});

test("medium and low are never limited", () => {
  assert.equal(priorityRefusal("ORTA", room(99, 99, 99)), null);
  assert.equal(priorityRefusal("PAST", room(99, 99, 99)), null);
});
