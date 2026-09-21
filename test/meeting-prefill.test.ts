import { test } from "node:test";
import assert from "node:assert/strict";
import {
  companyKey,
  forEmpty,
  matchCompany,
  parseSuggestion,
  resolveSuggestion,
  suggestedFields,
  type PrefillAnswer,
  type PrefillRoster,
} from "../src/lib/meeting-fields.ts";

const companies = [
  { id: 1, name: "Parsons Corporation" },
  { id: 2, name: "Uzum MChJ" },
  { id: 3, name: "O'zbekiston temir yo'llari AJ" },
  { id: 4, name: "Uzum Market" },
  { id: 5, name: "«Навои кон-металлургия комбинати» АЖ" },
];

test("a company is matched however its legal form and quotes are written", () => {
  assert.equal(companyKey("«Uzum» MChJ"), "uzum");
  assert.equal(matchCompany("Parsons", companies), 1);
  assert.equal(matchCompany("PARSONS CORP.", companies), 1);
  assert.equal(matchCompany("Навои кон-металлургия комбинати", companies), 5);
  assert.equal(matchCompany("O‘zbekiston temir yo‘llari", companies), 3);
});

test("a name two companies could answer to matches neither", () => {
  // "Uzum" is Uzum MChJ exactly, so that one wins over Uzum Market.
  assert.equal(matchCompany("Uzum", companies), 2);
  // A fragment this short is inside too many names to mean one of them.
  assert.equal(matchCompany("Uz", companies), null);
  assert.equal(
    matchCompany("Temir", [
      { id: 8, name: "Temir yo'l servis" },
      { id: 9, name: "Temir beton" },
    ]),
    null,
  );
  assert.equal(matchCompany("", companies), null);
});

const roster: PrefillRoster = {
  staff: [
    { id: 10, login: "a.karimov" },
    { id: 11, login: "d.rashidova" },
    { id: 12, login: "rais" },
  ],
  responsibles: [10, 11],
  projects: [
    { id: 20, code: "LY-001" },
    { id: 21, code: "LY-002" },
  ],
  companies,
  today: "2026-09-18",
};

const answer: PrefillAnswer = {
  held_at: "2026-09-11",
  place: "Toshkent, Assambleya binosi",
  company: "Parsons",
  participants: "John Smith — VP Infrastructure, Parsons",
  staff: ["a.karimov", "RAIS", "nobody"],
  projects: ["ly-001", "LY-999"],
  discussed: "Termiz logistika markazi bo'yicha texnik-iqtisodiy asos.",
  agreed: "MOU matni kelishildi; oktyabrda imzolanadi.",
  open_issues: "",
  next_step: "MOU loyihasini yuborish",
  responsible: "d.rashidova",
  legal_status: "NEGOTIATION",
};

test("the answer becomes a suggestion naming only rows that exist", () => {
  assert.deepEqual(resolveSuggestion(answer, roster), {
    held_at: "2026-09-11",
    place: "Toshkent, Assambleya binosi",
    company_id: 1,
    participants: "John Smith — VP Infrastructure, Parsons",
    // An invented login is dropped; the chairman may be in the room.
    staff_ids: [10, 12],
    // An unknown code is dropped; case does not matter.
    project_ids: [20],
    description: "Termiz logistika markazi bo'yicha texnik-iqtisodiy asos.",
    agreed: "MOU matni kelishildi; oktyabrda imzolanadi.",
    next_steps: "MOU loyihasini yuborish",
    responsible_id: 11,
    legal_status: "NEGOTIATION",
  });
});

test("what the model cannot back up is left out rather than guessed", () => {
  const s = resolveSuggestion(
    {
      ...answer,
      // A meeting with a transcript has happened; a later date is a deadline.
      held_at: "2026-10-01",
      company: "Some Startup Nobody Filed",
      // The chairman receives no assignments; the reviewer cannot make them responsible.
      responsible: "rais",
      legal_status: "SIGNED_PROBABLY",
    },
    roster,
  );
  assert.equal(s.held_at, undefined);
  assert.equal(s.company_id, undefined);
  assert.equal(s.company_heard, "Some Startup Nobody Filed");
  assert.equal(s.responsible_id, undefined);
  assert.equal(s.legal_status, undefined);
  assert.equal(resolveSuggestion({ ...answer, held_at: "11.09.2026" }, roster).held_at, undefined);
});

test("a suggestion never stands over a field somebody filled", () => {
  const s = resolveSuggestion(answer, roster);
  const open = forEmpty(s, {
    held_at: "2026-09-10",
    company_id: null,
    agreed: "  ",
    project_ids: [21],
    staff_ids: [],
    responsible_id: 10,
  });
  assert.equal(open.held_at, undefined);
  assert.equal(open.responsible_id, undefined);
  // Blank and whitespace-only are empty.
  assert.equal(open.company_id, 1);
  assert.equal(open.agreed, s.agreed);
  assert.deepEqual(open.staff_ids, [10, 12]);
  // A list is added to, never replaced: the project already there stays out
  // of the suggestion, the one the model heard goes in.
  assert.deepEqual(open.project_ids, [20]);
});

test("a list only gains what it lacks", () => {
  const s = { staff_ids: [10, 12], project_ids: [20] };
  // The author ticked by default does not stop the others being proposed.
  assert.deepEqual(forEmpty(s, { staff_ids: [10], project_ids: [20] }), { staff_ids: [12] });
  assert.deepEqual(forEmpty(s, { staff_ids: [12, 10], project_ids: [20, 21] }), {});
});

test("the company as heard goes only where no company is set", () => {
  const s = { company_heard: "Some Startup" };
  assert.deepEqual(forEmpty(s, { company_id: null }), { company_heard: "Some Startup" });
  assert.deepEqual(forEmpty(s, { company_id: 4 }), {});
  // It is a hint, not a field: nothing is proposed by it alone.
  assert.deepEqual(suggestedFields(s), []);
});

test("the suggested fields are listed in the order of the form", () => {
  assert.deepEqual(suggestedFields(resolveSuggestion(answer, roster)), [
    "held_at",
    "place",
    "company_id",
    "legal_status",
    "project_ids",
    "description",
    "agreed",
    "next_steps",
    "responsible_id",
    "participants",
    "staff_ids",
  ]);
  assert.deepEqual(suggestedFields(null), []);
});

test("a stored suggestion reads back, and anything else reads as none", () => {
  assert.deepEqual(parseSuggestion('{"agreed":"MOU"}'), { agreed: "MOU" });
  assert.equal(parseSuggestion('{"company_heard":"X"}'), null);
  assert.equal(parseSuggestion("[1,2]"), null);
  assert.equal(parseSuggestion("not json"), null);
  assert.equal(parseSuggestion(null), null);
});
