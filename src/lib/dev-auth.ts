import { cookies } from "next/headers";
import crypto from "node:crypto";

/**
 * Hidden dev control panel. Access is a shared secret, not a role — the panel
 * is invisible (a 404) to anyone without it. Set DEV_PANEL_KEY in production;
 * a stable default exists only for local development.
 */
export const DEV_COOKIE = "assambleya_dev";

function devKey(): string | null {
  const configured = process.env.DEV_PANEL_KEY?.trim();
  if (process.env.NODE_ENV === "production") {
    if (process.env.DEV_PANEL_ENABLED !== "1") return null;
    return configured && configured.length >= 32 ? configured : null;
  }
  return configured || "assambleya-dev-2026";
}

/** Constant-time compare so the key can't be guessed by timing. */
export function keyMatches(candidate: string | undefined | null): boolean {
  if (!candidate) return false;
  const key = devKey();
  if (!key) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** True when the current request carries a valid dev-panel cookie. */
export async function hasDevAccess(): Promise<boolean> {
  const jar = await cookies();
  return keyMatches(jar.get(DEV_COOKIE)?.value);
}
