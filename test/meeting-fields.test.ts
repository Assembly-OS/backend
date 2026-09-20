import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LEGAL_STATUSES,
  MEETING_REQUIRED,
  missingFields,
  type MeetingShape,
} from "../src/lib/meeting-fields.ts";

/** A meeting with every field the TZ requires filled in. */
const complete: MeetingShape = {
  held_at: "2026-09-11",
  company_id: 7,
  project_count: 1,
  participants: "John Smith, VP Infrastructure",
  staff_count: 2,
  description: "Termiz hub feasibility study",
  agreed: "MOU wording settled; signing in October",
  next_steps: "Send the draft MOU",
  responsible_id: 3,
  legal_status: "NEGOTIATION",
};

test("a meeting with every required field is complete", () => {
  assert.deepEqual(missingFields(complete), []);
});

test("a bare record lacks every required field, in the declared order", () => {
  const bare: MeetingShape = {
    held_at: null,
    company_id: null,
    project_count: 0,
    participants: null,
    staff_count: 0,
    description: null,
    agreed: null,
    next_steps: null,
    responsible_id: null,
    legal_status: null,
  };
  assert.deepEqual(missingFields(bare), [...MEETING_REQUIRED]);
});

test("whitespace is not an answer", () => {
  // A space typed into "what was agreed" must not make the record read as
  // complete: that field is the one the TZ says is asked years later.
  assert.deepEqual(missingFields({ ...complete, agreed: "   \n " }), ["agreed"]);
});

test("a first meeting with no project yet is saved and shows the gap", () => {
  assert.deepEqual(missingFields({ ...complete, project_count: 0 }), ["projects"]);
});

test("a next step nobody answers for is not a next step", () => {
  assert.deepEqual(
    missingFields({ ...complete, responsible_id: null }),
    ["next_step"],
  );
});

test("only a known legal status counts", () => {
  assert.deepEqual(
    missingFields({ ...complete, legal_status: "SIGNED_PROBABLY" }),
    ["legal_status"],
  );
  for (const status of LEGAL_STATUSES) {
    assert.deepEqual(missingFields({ ...complete, legal_status: status }), []);
  }
});
