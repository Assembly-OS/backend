import { test } from "node:test";
import assert from "node:assert/strict";
import { check, recordFailure, reset } from "../src/lib/rate-limit.ts";

test("allows attempts under the limit, then blocks at it", () => {
  const key = "test:under-limit";
  reset(key);
  for (let i = 0; i < 5; i++) {
    assert.equal(check(key).blocked, false, `attempt ${i + 1} should pass`);
    recordFailure(key);
  }
  const state = check(key);
  assert.equal(state.blocked, true);
  assert.ok(state.retryAfter > 0, "a blocked key reports a retry delay");
  assert.equal(state.remaining, 0);
});

test("reset clears the strike count", () => {
  const key = "test:reset";
  for (let i = 0; i < 6; i++) recordFailure(key);
  assert.equal(check(key).blocked, true);
  reset(key);
  assert.equal(check(key).blocked, false);
  assert.equal(check(key).remaining, 5);
});

test("buckets are independent", () => {
  reset("test:a");
  reset("test:b");
  for (let i = 0; i < 6; i++) recordFailure("test:a");
  assert.equal(check("test:a").blocked, true);
  assert.equal(check("test:b").blocked, false);
});

test("a custom limit is honoured", () => {
  const key = "test:custom";
  reset(key);
  recordFailure(key);
  recordFailure(key);
  assert.equal(check(key, 2).blocked, true);
  assert.equal(check(key, 5).blocked, false);
});
