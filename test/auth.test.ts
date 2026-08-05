import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createToken,
  hashPassword,
  readToken,
  verifyPassword,
} from "../src/lib/auth.ts";

test("a token round-trips its payload", () => {
  const token = createToken({ uid: 7, login: "rais", role: "RAIS" });
  const payload = readToken(token);
  assert.equal(payload?.uid, 7);
  assert.equal(payload?.login, "rais");
  assert.equal(payload?.role, "RAIS");
});

test("a tampered payload is rejected", () => {
  const [head, body, sig] = createToken({
    uid: 7,
    login: "rais",
    role: "RAIS",
  }).split(".");
  const flipped = body.endsWith("A") ? body.slice(0, -1) + "B" : body.slice(0, -1) + "A";
  assert.equal(readToken(`${head}.${flipped}.${sig}`), null);
});

test("garbage and empty tokens are null", () => {
  assert.equal(readToken(undefined), null);
  assert.equal(readToken(""), null);
  assert.equal(readToken("not.a.jwt"), null);
});

test("an expired token is rejected", () => {
  const token = createToken({ uid: 1, login: "x", role: "RAIS" }, -10);
  assert.equal(readToken(token), null);
});

test("passwords verify, and wrong passwords do not", () => {
  const stored = hashPassword("correct horse battery staple");
  assert.equal(verifyPassword("correct horse battery staple", stored), true);
  assert.equal(verifyPassword("wrong", stored), false);
});

test("a malformed stored hash never verifies", () => {
  assert.equal(verifyPassword("x", "not-a-real-hash"), false);
});

test("each hash uses a fresh random salt", () => {
  assert.notEqual(hashPassword("same"), hashPassword("same"));
});
