import crypto from "node:crypto";
import { cookies } from "next/headers";
import { createToken, readToken, verifyPassword } from "./auth";

/**
 * The administration panel has its own door. It is not a role inside the org
 * chart and not an employee account: no staff login opens it, and the admin
 * login opens nothing in the platform. The credentials live in the server's
 * environment rather than the users table, so the panel survives any change to
 * the staff — including deactivating every last one of them.
 */

export const ADMIN_COOKIE = "assambleya_admin";

/** Marks a token as belonging to the panel. No user row can hold this role —
 *  `ROLES` has no "ADMIN" — so a staff session token can never be replayed
 *  into the admin cookie, even though both are signed with the same secret. */
const ADMIN_ROLE = "ADMIN";

const TTL_SECONDS = 60 * 60 * 8;

export const ADMIN_LOGIN = process.env.ADMIN_LOGIN?.trim() || "admin";

/** The exact shape `hashPassword` writes: scheme, 16-byte salt, 64-byte hash. */
const HASH_SHAPE = /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/;

/**
 * True when a usable administrator password has been configured. There is
 * deliberately no built-in default: a panel shipping with a known password is
 * a back door, so an unconfigured install refuses every login instead.
 *
 * The shape check is not paranoia. `.env` values run through dotenv's variable
 * expansion, and a scrypt hash is full of `$` — written unescaped, `$<salt>`
 * reads as an undefined variable and the hash silently becomes "scrypt". That
 * failure is indistinguishable from a wrong password at the login screen, so
 * a malformed hash is reported as "not configured" instead. Escape the dollars
 * (`scrypt\$…\$…`) when writing the value.
 */
export function isConfigured(): boolean {
  const hash = process.env.ADMIN_PASSWORD_HASH?.trim();
  if (hash) return HASH_SHAPE.test(hash);
  return process.env.NODE_ENV !== "production" && Boolean(process.env.ADMIN_PASSWORD);
}

/** Constant-time comparison for the plaintext fallback. */
function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return (
    left.length === right.length && crypto.timingSafeEqual(left, right)
  );
}

/**
 * Checks a login attempt. `ADMIN_PASSWORD_HASH` (scrypt, the format
 * `hashPassword` produces) is preferred; `ADMIN_PASSWORD` is accepted as a
 * plaintext fallback for a quick local setup.
 */
export function checkCredentials(login: string, password: string): boolean {
  if (!isConfigured()) return false;
  if (!sameString(login.trim().toLowerCase(), ADMIN_LOGIN.toLowerCase()))
    return false;

  const hash = process.env.ADMIN_PASSWORD_HASH?.trim();
  if (hash && HASH_SHAPE.test(hash)) return verifyPassword(password, hash);

  if (process.env.NODE_ENV === "production") return false;
  const plain = process.env.ADMIN_PASSWORD ?? "";
  return plain.length > 0 && sameString(password, plain);
}

export function createAdminToken(): string {
  return createToken(
    { uid: 0, login: ADMIN_LOGIN, role: ADMIN_ROLE },
    TTL_SECONDS,
  );
}

export const ADMIN_MAX_AGE = TTL_SECONDS;

/** True when the current request carries a valid, unexpired admin session. */
export async function hasAdminSession(): Promise<boolean> {
  const jar = await cookies();
  const payload = readToken(jar.get(ADMIN_COOKIE)?.value);
  return payload?.role === ADMIN_ROLE;
}
