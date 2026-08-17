import crypto from "node:crypto";

const DEV_SECRET = "assambleya-ai-os-dev-secret-change-me-in-prod";

/**
 * Session tokens are signed with this. If it leaks or is left at the dev
 * default in production, anyone can forge a token and log in as any user — so
 * a production boot without a strong AUTH_SECRET is a hard failure, not a
 * silent fallback. Development still gets a convenient default.
 */
function resolveSecret(): string {
  const fromEnv = process.env.AUTH_SECRET?.trim();
  if (fromEnv && fromEnv.length >= 16 && fromEnv !== DEV_SECRET) return fromEnv;

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "AUTH_SECRET is required in production and must be a strong, unique value " +
        "of at least 16 characters. Session tokens are signed with it; running " +
        "without it would let anyone forge a login.",
    );
  }
  return DEV_SECRET;
}

const SECRET = resolveSecret();
const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours

/* ------------------------------------------------------------------ */
/* Passwords                                                           */
/* ------------------------------------------------------------------ */

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password.normalize("NFKC"), salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/**
 * Whether the session cookie may carry the `Secure` flag on this request.
 *
 * It must follow the protocol the browser actually used, not NODE_ENV: a
 * production build served over plain http — which is exactly how the platform
 * runs on localhost — would otherwise hand out a cookie that Safari refuses to
 * store, and the user would be bounced back to the login screen with correct
 * credentials. Behind the cloudflared tunnel the request arrives as https via
 * `x-forwarded-proto`, so the flag is set where it genuinely protects.
 */
export function isSecureRequest(request: Request): boolean {
  const forwarded = request.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0].trim() === "https";
  return new URL(request.url).protocol === "https:";
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(
    password.normalize("NFKC"),
    Buffer.from(saltHex, "hex"),
    expected.length,
  );
  return crypto.timingSafeEqual(expected, actual);
}

/* ------------------------------------------------------------------ */
/* Session token (compact HS256 JWT)                                   */
/* ------------------------------------------------------------------ */

export interface SessionPayload {
  uid: number;
  login: string;
  role: string;
  exp: number;
}

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString("base64url");

function sign(data: string): string {
  return crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
}

export function createToken(
  payload: Omit<SessionPayload, "exp">,
  ttlSeconds = SESSION_TTL_SECONDS,
): string {
  const body: SessionPayload = {
    ...payload,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const data = `${head}.${b64url(JSON.stringify(body))}`;
  return `${data}.${sign(data)}`;
}

export function readToken(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(sign(data));
  const actual = Buffer.from(parts[2]);
  if (expected.length !== actual.length) return null;
  if (!crypto.timingSafeEqual(expected, actual)) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as SessionPayload;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = "assambleya_session";
export const SESSION_MAX_AGE = SESSION_TTL_SECONDS;
