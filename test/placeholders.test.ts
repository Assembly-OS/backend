import { test } from "node:test";
import assert from "node:assert/strict";
import { toPlaceholders } from "../src/lib/pg.ts";

/** How many `$n` the translated query ends up carrying. */
function count(sql: string): number {
  return (toPlaceholders(sql).match(/\$\d+/g) ?? []).length;
}

test("numbers every parameter in order", () => {
  assert.equal(
    toPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?"),
    "SELECT * FROM t WHERE a = $1 AND b = $2",
  );
});

test("leaves a question mark inside a string literal alone", () => {
  assert.equal(
    toPlaceholders("SELECT * FROM t WHERE body LIKE '%?%' AND id = ?"),
    "SELECT * FROM t WHERE body LIKE '%?%' AND id = $1",
  );
});

test("an escaped quote does not end the literal", () => {
  assert.equal(count("SELECT '''?''' AS a, ? AS b"), 1);
});

test("an apostrophe in a line comment does not swallow the parameters after it", () => {
  // The reports page died on exactly this: a comment ending in `week's` read
  // as an open string literal, and the two `?` below it were never numbered.
  const sql = `SELECT
       -- somebody who did nothing should not register a week's activity
       (SELECT COUNT(*) FROM e WHERE e.at >= ? AND e.at < ?) AS actions
     FROM u WHERE u.is_active = 1`;
  assert.equal(count(sql), 2);
});

test("an apostrophe in a block comment is inert too", () => {
  assert.equal(count("SELECT /* SQLite's MIN */ ? , ?"), 2);
  assert.equal(count("SELECT /* a /* nested's */ one */ ?"), 1);
});

test("a question mark inside a comment is not a parameter", () => {
  assert.equal(count("SELECT ? -- is this one? no\n, ?"), 2);
});

test("-- inside a string literal does not start a comment", () => {
  assert.equal(count("SELECT '-- not a comment' AS a, ? AS b"), 1);
});

test("a quoted identifier does not open a string", () => {
  assert.equal(
    toPlaceholders(`SELECT 1 AS "approvedForOthers" WHERE a = ?`),
    `SELECT 1 AS "approvedForOthers" WHERE a = $1`,
  );
});
