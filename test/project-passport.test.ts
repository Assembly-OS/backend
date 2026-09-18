import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PASSPORT_REQUIRED,
  PHASES,
  PHASE_STATUS,
  isDraft,
  missingPassport,
  pppComplete,
  type PassportShape,
} from "../src/lib/project-passport.ts";
import { PROJECT_STATUSES } from "../src/lib/project-vocab.ts";

const complete: PassportShape = {
  name: "Termiz sanoat xabi",
  name_ru: "Термезский индустриальный хаб",
  name_en: "Termiz Industrial Hub",
  description: "Tavsif",
  description_ru: "Описание",
  description_en: "Description",
  klaster_id: 1,
  tier: "FLAGSHIP",
  owner_id: 2,
  leader_name: null,
  deputy_id: null,
  deputy_name: "A. Karimov, hokimiyat",
  ppp_state: 40,
  ppp_public: 10,
  ppp_private: 50,
  phase: "FEASIBILITY",
  next_decision_on: "2026-10-01",
  started_at: "2026-03-01",
  deadline: "2028-12-31",
  first_result: "Feasibility study signed off by the ministry",
};

const bare: PassportShape = {
  name: "Only a name",
  name_ru: null,
  name_en: null,
  description: null,
  description_ru: null,
  description_en: null,
  klaster_id: null,
  tier: null,
  owner_id: null,
  leader_name: null,
  deputy_id: null,
  deputy_name: null,
  ppp_state: null,
  ppp_public: null,
  ppp_private: null,
  phase: null,
  next_decision_on: null,
  started_at: null,
  deadline: null,
  first_result: null,
};

test("a full passport is complete and not a draft", () => {
  assert.deepEqual(missingPassport(complete), []);
  assert.equal(isDraft(complete), false);
});

test("a bare project lacks everything, in the declared order, and is a draft", () => {
  assert.deepEqual(missingPassport(bare), [...PASSPORT_REQUIRED]);
  assert.equal(isDraft(bare), true);
});

test("a name in one language is not the names the TZ asks for", () => {
  assert.deepEqual(missingPassport({ ...complete, name_en: "  " }), ["names"]);
});

test("a leader or deputy outside the Assembly counts, named", () => {
  // The TZ says of the leader that he may not be on the staff.
  assert.deepEqual(
    missingPassport({ ...complete, owner_id: null, leader_name: "B. Tursunov, investor" }),
    [],
  );
});

test("partnership shares must be given and total a hundred", () => {
  assert.equal(pppComplete({ state: 40, public: 10, private: 50 }), true);
  assert.equal(pppComplete({ state: 0, public: 0, private: 100 }), true, "a zero is an answer");
  assert.equal(pppComplete({ state: 40, public: 10, private: 40 }), false, "90 is a typo");
  assert.equal(pppComplete({ state: 60, public: 10, private: 40 }), false, "110 is two sets merged");
  assert.equal(pppComplete({ state: 50, public: null, private: 50 }), false, "a blank is not a zero");
  assert.equal(pppComplete({ state: 33.5, public: 33, private: 33.5 }), false, "whole percentages");
  assert.equal(pppComplete({ state: -10, public: 60, private: 50 }), false);
});

test("the entry condition decides draft, not every field", () => {
  // Missing a translation or a decision date does not make a project a draft;
  // missing its deputy does.
  assert.equal(isDraft({ ...complete, name_ru: null, next_decision_on: null }), false);
  assert.equal(isDraft({ ...complete, deputy_name: null }), true);
  assert.equal(isDraft({ ...complete, first_result: null }), true);
});

test("every phase maps to a status that exists", () => {
  for (const phase of PHASES) {
    assert.ok(
      (PROJECT_STATUSES as readonly string[]).includes(PHASE_STATUS[phase]),
      `${phase} → ${PHASE_STATUS[phase]}`,
    );
  }
});
