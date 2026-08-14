import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baseMime,
  isInline,
  MAX_BYTES,
  resolveKind,
  resolvePath,
  safeName,
} from "../src/lib/uploads.ts";

test("codec parameters are stripped before an allow-list lookup", () => {
  assert.equal(baseMime("audio/webm;codecs=opus"), "audio/webm");
  assert.equal(baseMime("IMAGE/PNG"), "image/png");
  assert.equal(baseMime(" image/jpeg "), "image/jpeg");
});

test("a renderable photo and a playable voice note keep their kind", () => {
  assert.equal(resolveKind("photo", "image/jpeg"), "photo");
  assert.equal(resolveKind("photo", "image/webp"), "photo");
  assert.equal(resolveKind("voice", "audio/webm;codecs=opus"), "voice");
  assert.equal(resolveKind("voice", "audio/mp4"), "voice");
});

test("anything the browser cannot render inline degrades to a file", () => {
  // The dangerous cases: both would be stored-XSS if served inline.
  assert.equal(resolveKind("photo", "text/html"), "file");
  assert.equal(resolveKind("photo", "image/svg+xml"), "file");
  // And the merely unrenderable ones.
  assert.equal(resolveKind("photo", "image/heic"), "file");
  assert.equal(resolveKind("voice", "application/zip"), "file");
  assert.equal(resolveKind("file", "image/png"), "file");
});

test("only allow-listed types are ever served inline", () => {
  assert.equal(isInline("photo", "image/png"), true);
  assert.equal(isInline("voice", "audio/ogg;codecs=opus"), true);
  assert.equal(isInline("file", "image/png"), false, "a file always downloads");
  assert.equal(isInline("photo", "image/svg+xml"), false);
  assert.equal(isInline("text", "image/png"), false);
});

test("display names lose separators and control characters, keep the rest", () => {
  assert.equal(safeName("../../etc/passwd", "file"), "....etcpasswd");
  assert.equal(safeName("a\\b/c.txt", "file"), "abc.txt");
  assert.equal(safeName("head\r\ninjected: yes", "file"), "headinjected: yes");
  // Spaces, punctuation and non-ASCII are legitimate and must survive.
  assert.equal(
    safeName("Отчёт за 2026 (final) v2.txt", "file"),
    "Отчёт за 2026 (final) v2.txt",
  );
  assert.equal(safeName("", "voice"), "voice-message");
  assert.equal(safeName("   ", "file"), "file");
  assert.equal(safeName("x".repeat(300), "file").length, 160);
});

test("a key that is not one we could have written never resolves", () => {
  // Traversal, absolute paths, backslashes and stray extensions all fail the
  // shape check, so no lookup reaches the filesystem at all.
  for (const key of [
    "../../../etc/passwd",
    "/etc/passwd",
    "2026/08/../../../etc/passwd",
    "2026\\08\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
    "2026/08/notahexkey.png",
    "2026/8/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
    "",
  ]) {
    assert.equal(resolvePath(key), null, `must reject ${JSON.stringify(key)}`);
  }
});

test("the per-kind size ceilings are ordered and non-zero", () => {
  assert.ok(MAX_BYTES.photo > 0);
  assert.ok(MAX_BYTES.voice >= MAX_BYTES.photo);
  assert.ok(MAX_BYTES.file >= MAX_BYTES.voice);
});
