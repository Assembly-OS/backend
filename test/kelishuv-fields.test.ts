import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KELISHUV_REQUIRED,
  kelishuvCode,
  missingKelishuv,
  viewKelishuv,
  type KelishuvShape,
} from "../src/lib/kelishuv-fields.ts";

const complete: KelishuvShape = {
  kind: "MOU",
  party_count: 1,
  loyiha_id: 4,
  content: "Feasibility study of the Termiz hub, jointly funded",
  obligation_count: 2,
  responsible_id: 3,
};

test("an agreement with every required field is complete", () => {
  assert.deepEqual(missingKelishuv(complete), []);
});

test("a bare draft lacks every required field, in the declared order", () => {
  assert.deepEqual(
    missingKelishuv({
      kind: null,
      party_count: 0,
      loyiha_id: null,
      content: "  ",
      obligation_count: 0,
      responsible_id: null,
    }),
    [...KELISHUV_REQUIRED],
  );
});

test("an agreement binding nobody to anything is incomplete", () => {
  assert.deepEqual(missingKelishuv({ ...complete, obligation_count: 0 }), [
    "obligations",
  ]);
});

test("an unknown kind is no kind", () => {
  assert.deepEqual(missingKelishuv({ ...complete, kind: "HANDSHAKE" }), ["kind"]);
});

test("an open agreement past its term reads as expired", () => {
  assert.equal(viewKelishuv("OPEN", "2026-09-01", "2026-09-18"), "EXPIRED");
});

test("the last day of the term is not yet expired", () => {
  assert.equal(viewKelishuv("OPEN", "2026-09-18", "2026-09-18"), "OPEN");
});

test("only an open agreement can expire", () => {
  // A finished or cancelled agreement whose term has passed is history, not
  // a problem; a draft was never in force.
  for (const status of ["DONE", "CANCELLED", "DRAFT"]) {
    assert.equal(viewKelishuv(status, "2020-01-01", "2026-09-18"), status);
  }
});

test("an open agreement with no term never expires", () => {
  assert.equal(viewKelishuv("OPEN", null, "2099-01-01"), "OPEN");
});

test("an unrecognised stored status reads as a draft, not as a crash", () => {
  assert.equal(viewKelishuv("SIGNED", null, "2026-09-18"), "DRAFT");
});

test("agreements are cited K-0007", () => {
  assert.equal(kelishuvCode(7), "K-0007");
  assert.equal(kelishuvCode(12345), "K-12345");
});
