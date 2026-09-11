import crypto from "node:crypto";

/**
 * Who is allowed into the hidden dev control panel — the policy alone, with no
 * request plumbing, so it can be tested directly.
 *
 * In production the panel is shut unless it is deliberately opened.
 * DEPLOYMENT.md has said so for a while — "unless DEV_PANEL_ENABLED=1" — but
 * nothing read that variable. The only gate was the key, and the key fell back
 * to the constant below, which lives in a public repository. Behind that gate
 * sit user.resetPassword, user.setRole, user.delete and maint.reseed, so the
 * fallback is now development-only and production has to be told twice before
 * the door opens at all.
 */
export const DEV_COOKIE = "assambleya_dev";

/** Development convenience. Deliberately useless in production. */
const DEV_KEY = "assambleya-dev-2026";

/** What DEPLOYMENT.md asks a real key to be. */
const MIN_KEY_LENGTH = 32;

/**
 * The key this process accepts, or null when the panel is shut.
 *
 * Null rather than a throw for the shut case, because a closed panel has to
 * look like it was never built: a 500 tells a stranger the route exists, which
 * is the one thing this design is buying. The throw is kept for the single
 * configuration that is actively wrong — a production deployment that asked
 * for the panel and then handed it a guessable key.
 */
export function resolveDevKey(): string | null {
  const fromEnv = process.env.DEV_PANEL_KEY?.trim();

  if (process.env.NODE_ENV !== "production") return fromEnv || DEV_KEY;
  if (process.env.DEV_PANEL_ENABLED !== "1") return null;

  if (!fromEnv || fromEnv.length < MIN_KEY_LENGTH || fromEnv === DEV_KEY) {
    throw new Error(
      `DEV_PANEL_ENABLED=1 requires a unique DEV_PANEL_KEY of at least ${MIN_KEY_LENGTH} ` +
        "characters. The panel resets passwords, changes roles and deletes rows; " +
        "the development default is published and must never guard it.",
    );
  }

  return fromEnv;
}

/** Constant-time compare so the key can't be guessed by timing. */
export function keyMatches(candidate: string | undefined | null): boolean {
  if (!candidate) return false;
  const expected = resolveDevKey();
  if (!expected) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
