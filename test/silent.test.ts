import { test } from "node:test";
import assert from "node:assert/strict";
import { REPORTING_STATUSES, silentSince, silentSql } from "../src/lib/metrics.ts";

// "Jim", TZ block 3.2. The fragment is spliced into queries whose placeholders
// are numbered by position, so it must not carry any of its own.
test("the silent fragments consume no placeholders", () => {
  for (const sql of [silentSql(), silentSql("t"), silentSince(), silentSince("t")]) {
    assert.equal(sql.includes("?"), false, sql);
  }
});

// Without an alias the caller reads `FROM tasks`; inside the journal
// subquery a bare `id` would be the journal row's, not the task's.
test("the outer table is named even when the caller gave it no alias", () => {
  assert.match(silentSince(), /p\.task_id = tasks\.id/);
  assert.match(silentSince("t"), /p\.task_id = t\.id/);
  assert.doesNotMatch(silentSince(), /p\.task_id = id\b/);
});

test("only open-ended work that is being carried can go quiet", () => {
  const sql = silentSql("t");
  assert.match(sql, /t\.kind = 'MUDDATSIZ'/);
  for (const status of REPORTING_STATUSES) assert.match(sql, new RegExp(`'${status}'`));
  assert.doesNotMatch(sql, /'YANGI'|'TEKSHIRUVDA'|'BAJARILDI'/);
});

test("the rhythm decides the window: a month, or a week by default", () => {
  const sql = silentSql();
  assert.match(sql, /WHEN 'MONTHLY' THEN interval '30 days' ELSE interval '7 days'/);
});
