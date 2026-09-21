import { test } from "node:test";
import assert from "node:assert/strict";
import { TASK_STATUSES } from "../src/lib/types.ts";
import {
  CLOSED_STATUSES,
  DONE_STATUSES,
  OPEN_STATUSES,
  REJECTED_STATUSES,
  doneSql,
  openSql,
  overdueSql,
  rejectedSql,
  statusList,
  METRICS,
} from "../src/lib/metrics.ts";

/** How many parameters a fragment consumes from the caller's argument list. */
function placeholders(sql: string): number {
  return (sql.match(/\?/g) ?? []).length;
}

/* ------------------------------------------------------------------ */
/* The property the page totals rest on                                */
/* ------------------------------------------------------------------ */

test("every status lands in exactly one bucket", () => {
  // This is the whole of block 2 in one assertion. The audit found the
  // statistics page showing a total of 67 with columns that summed to less,
  // and the cause was not arithmetic: `QAYTARILDI` was in neither "done" nor
  // "active", so returned work sat in the total and nowhere else. A status
  // that belongs to no bucket is work the Assembly cannot see.
  for (const status of TASK_STATUSES) {
    const buckets = [OPEN_STATUSES, DONE_STATUSES, REJECTED_STATUSES].filter(
      (bucket) => bucket.includes(status),
    );
    assert.equal(
      buckets.length,
      1,
      `${status} belongs to ${buckets.length} buckets, expected exactly 1`,
    );
  }
});

test("the buckets together cover every status and invent none", () => {
  const covered = [
    ...OPEN_STATUSES,
    ...DONE_STATUSES,
    ...REJECTED_STATUSES,
  ].sort();
  assert.deepEqual(covered, [...TASK_STATUSES].sort());
});

test("work returned for rework is still open", () => {
  // Named on its own because it is the one the old queries got wrong, and a
  // future tidy-up that "simplifies" OPEN_STATUSES back to four entries
  // should fail here rather than quietly hide the rework again.
  assert.ok(OPEN_STATUSES.includes("QAYTARILDI"));
});

test("closed is done plus rejected, and nothing else", () => {
  assert.deepEqual([...CLOSED_STATUSES].sort(), ["BAJARILDI", "RAD_ETILDI"]);
});

/* ------------------------------------------------------------------ */
/* The placeholder contract                                            */
/* ------------------------------------------------------------------ */

test("only the overdue fragment consumes a parameter, and exactly one", () => {
  // `lib/pg` numbers `?` by position. A fragment that changes how many it
  // carries silently shifts every argument after it in the calling query —
  // which does not throw, it returns the wrong rows.
  for (const alias of ["", "t", "s"]) {
    assert.equal(placeholders(openSql(alias)), 0, `openSql(${alias})`);
    assert.equal(placeholders(doneSql(alias)), 0, `doneSql(${alias})`);
    assert.equal(placeholders(rejectedSql(alias)), 0, `rejectedSql(${alias})`);
    assert.equal(placeholders(overdueSql(alias)), 1, `overdueSql(${alias})`);
  }
});

test("an alias qualifies every column in the fragment", () => {
  // A half-qualified fragment is ambiguous the moment a query joins a second
  // table that also has `status` — Postgres rejects it, but only for the
  // queries that happen to join.
  const sql = overdueSql("t");
  assert.ok(!/(?<![.\w])deadline/.test(sql), `unqualified deadline in ${sql}`);
  assert.ok(!/(?<![.\w])status/.test(sql), `unqualified status in ${sql}`);
});

test("a bare fragment qualifies nothing", () => {
  assert.equal(overdueSql().includes("."), false);
});

/* ------------------------------------------------------------------ */
/* Shape                                                               */
/* ------------------------------------------------------------------ */

test("a status list is quoted and comma separated", () => {
  assert.equal(statusList(["BAJARILDI", "RAD_ETILDI"]), "'BAJARILDI','RAD_ETILDI'");
});

test("no status can smuggle a quote into a fragment", () => {
  // The lists are inlined rather than parameterised, which is safe only for as
  // long as they come from the closed union. If someone widens `TaskStatus` to
  // a free string this stops being true, and the assertion is where they find
  // out.
  for (const status of TASK_STATUSES) {
    assert.ok(/^[A-Z_]+$/.test(status), `${status} is not a bare identifier`);
  }
});

test("every registered metric carries its own key and a scope", () => {
  for (const [key, meta] of Object.entries(METRICS)) {
    assert.equal(meta.key, key, `${key} is registered under a different key`);
    assert.ok(meta.scope, `${key} has no scope`);
  }
});
