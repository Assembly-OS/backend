import { test } from "node:test";
import assert from "node:assert/strict";
import { keyMatches } from "../src/lib/dev-key.ts";

/** The published development default, as it appears in the public repo. */
const PUBLISHED = "assambleya-dev-2026";
const REAL = "x".repeat(32);

function withEnv(env: Record<string, string | undefined>, run: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    run();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("development accepts the convenience key", () => {
  withEnv({ NODE_ENV: "development", DEV_PANEL_KEY: undefined }, () => {
    assert.equal(keyMatches(PUBLISHED), true);
  });
});

test("production ignores the published default even when it is handed over", () => {
  withEnv(
    { NODE_ENV: "production", DEV_PANEL_ENABLED: undefined, DEV_PANEL_KEY: undefined },
    () => {
      assert.equal(keyMatches(PUBLISHED), false);
    },
  );
});

test("production keeps the panel shut until it is enabled, key or no key", () => {
  withEnv(
    { NODE_ENV: "production", DEV_PANEL_ENABLED: undefined, DEV_PANEL_KEY: REAL },
    () => {
      assert.equal(keyMatches(REAL), false);
    },
  );
});

test("enabling the panel with a weak key is a hard failure, not a quiet fallback", () => {
  for (const key of [undefined, PUBLISHED, "short"]) {
    withEnv(
      { NODE_ENV: "production", DEV_PANEL_ENABLED: "1", DEV_PANEL_KEY: key },
      () => {
        assert.throws(() => keyMatches("anything"), /DEV_PANEL_KEY/);
      },
    );
  }
});

test("a deliberately opened panel with a real key still works", () => {
  withEnv({ NODE_ENV: "production", DEV_PANEL_ENABLED: "1", DEV_PANEL_KEY: REAL }, () => {
    assert.equal(keyMatches(REAL), true);
    assert.equal(keyMatches(PUBLISHED), false);
    assert.equal(keyMatches(undefined), false);
  });
});
