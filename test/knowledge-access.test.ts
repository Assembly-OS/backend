import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleSourcesSql } from "../src/lib/knowledge/access.ts";
import type { User } from "../src/lib/types.ts";

function person(role: User["role"], extra: Partial<User> = {}): User {
  return {
    id: 7,
    login: "someone",
    full_name: "Someone",
    role,
    department: "GR",
    position: null,
    uyushma_id: null,
    loyiha_id: null,
    manager_id: null,
    klaster_id: null,
    global_ai: 0,
    phone: null,
    email: null,
    lang: "uz",
    is_active: 1,
    last_seen: null,
    created_at: "2026-01-01 00:00:00",
    ...extra,
  };
}

/** `?` placeholders outside quotes — what pg.ts will number. */
function placeholders(sql: string): number {
  return (sql.replace(/'[^']*'/g, "").match(/\?/g) ?? []).length;
}

test("the parameters match the placeholders for every role", () => {
  for (const role of [
    "RAIS",
    "KLASTER_RAHBARI",
    "BOLIM_RAHBARI",
    "LOYIHA_RAHBARI",
    "AI_LAB",
    "ISHCHI",
    "TASHQI_LOYIHA_RAHBARI",
    "UYUSHMA_RAISI",
    "UYUSHMA_VAKILI",
  ] as const) {
    const scope = visibleSourcesSql(person(role));
    assert.equal(placeholders(scope.sql), scope.params.length, role);
  }
});

test("the chairman's global view reaches every record but no private chat", () => {
  const scope = visibleSourcesSql(person("RAIS"));
  assert.ok(scope.sql.includes("s.kind = 'task'"));
  assert.ok(!scope.sql.includes("s.kind = 'task' AND EXISTS"));
  assert.ok(scope.sql.includes("s.kind = 'thread_entry'"));
  // Chat is always bound to the participants: the clause carries the id.
  assert.match(scope.sql, /s\.kind = 'message' AND \(s\.from_user_id = 7 OR s\.to_user_id = 7/);
  // A PRIVATE library document is never widened.
  assert.ok(!scope.sql.includes("'PRIVATE'"));
});

test("an employee is scoped to involvement and visible projects", () => {
  const scope = visibleSourcesSql(person("ISHCHI"));
  assert.ok(scope.sql.includes("s.kind = 'task' AND EXISTS (SELECT 1 FROM tasks t"));
  assert.ok(scope.sql.includes("t.to_user_id = 7"));
  assert.ok(scope.sql.includes("s.kind = 'thread_entry' AND EXISTS (SELECT 1 FROM loyihalar l"));
  assert.ok(scope.sql.includes("s.kind = 'meeting' AND EXISTS (SELECT 1 FROM meetings m"));
  // The companies base is the staff's (TZ 4.3): its cards read with the agreements.
  assert.ok(scope.sql.includes("s.kind IN ('kelishuv', 'agreement', 'partner')"));
  assert.ok(scope.sql.includes("d.visibility = 'DEPARTMENT' AND d.department = ?"));
  assert.ok(scope.params.includes("GR"));
});

test("a department head granted the global view reads across the isolation", () => {
  const plain = visibleSourcesSql(person("BOLIM_RAHBARI"));
  const granted = visibleSourcesSql(person("BOLIM_RAHBARI", { global_ai: 1 }));
  assert.ok(plain.sql.includes("s.kind = 'task' AND EXISTS"));
  assert.ok(!granted.sql.includes("s.kind = 'task' AND EXISTS"));
  assert.ok(granted.sql.includes("d.visibility IN ('PROJECT', 'DEPARTMENT')"));
});

test("someone outside the Assembly sees his own project, his chats, nothing of the staff's", () => {
  const scope = visibleSourcesSql(person("TASHQI_LOYIHA_RAHBARI", { department: null }));
  assert.ok(!scope.sql.includes("thread_entry"), "no journal");
  assert.ok(!scope.sql.includes("kelishuv"), "no agreements base");
  assert.ok(!scope.sql.includes("'meeting'"), "no meetings");
  assert.ok(scope.sql.includes("s.kind IN ('project', 'project_document') AND EXISTS"));
  assert.ok(scope.sql.includes("s.kind = 'message'"));
  // A task of his is readable only through his involvement, never via a project.
  assert.ok(!scope.sql.includes("t.loyiha_id IS NOT NULL"));
  // Library: only what he uploaded himself.
  assert.ok(scope.sql.includes("d.uploaded_by = 7"));
  assert.ok(!scope.sql.includes("d.visibility = 'ALL'"));
});

test("an association's representative reads the association's meetings", () => {
  const scope = visibleSourcesSql(person("UYUSHMA_VAKILI", { uyushma_id: 3, department: null }));
  assert.ok(scope.sql.includes("m.uyushma_id = ?"));
  assert.ok(scope.params.includes(3));
});

test("a user id that is not an integer is refused before it reaches SQL", () => {
  assert.throws(() => visibleSourcesSql(person("RAIS", { id: Number.NaN })));
});
