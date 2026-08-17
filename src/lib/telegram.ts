import crypto from "node:crypto";

/**
 * Verifying that a Mini App request really came from Telegram.
 *
 * When Telegram opens the platform inside its webview it hands the page an
 * `initData` string — who the user is, when it was issued, and an HMAC over
 * the lot keyed by the bot token. Because only Telegram and this server know
 * that token, a valid signature is proof of identity: the person on the other
 * end is the Telegram account named in the payload.
 *
 * That makes this file a login path, and it is treated as one. The signature
 * is checked before a single field is read, the comparison is constant-time,
 * and stale payloads are refused — otherwise an `initData` copied out of one
 * session could be replayed into another for as long as the account existed.
 *
 * Getting this wrong is not a rendering bug: an unchecked `initData` lets
 * anybody claim to be the chairman by editing a query string.
 */

/**
 * How old a payload may be. Telegram re-issues `initData` on every launch, so
 * a day is generous for one session and short enough that a leaked string
 * stops working before it is worth using.
 */
const MAX_AGE_SECONDS = Number(process.env.TELEGRAM_INITDATA_MAX_AGE ?? 86_400);

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
}

export type TelegramCheck =
  | { ok: true; user: TelegramUser }
  | { ok: false; reason: "NO_TOKEN" | "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" };

function botToken(): string | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  return token ? token : null;
}

export function telegramConfigured(): boolean {
  return botToken() !== null;
}

/**
 * Checks an `initData` string and returns the Telegram account it names.
 *
 * The algorithm is Telegram's: build a newline-joined `key=value` list of
 * every field except `hash`, sorted by key; the signing key is
 * HMAC-SHA256("WebAppData", bot_token); the result must equal `hash`.
 */
export function verifyInitData(initData: string): TelegramCheck {
  const token = botToken();
  if (!token) return { ok: false, reason: "NO_TOKEN" };
  if (!initData || initData.length > 8192) return { ok: false, reason: "MALFORMED" };

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }

  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "MALFORMED" };

  const checkString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const expected = crypto
    .createHmac("sha256", secret)
    .update(checkString)
    .digest("hex");

  // Constant-time, and length-checked first: timingSafeEqual throws on a
  // length mismatch, and that throw would itself leak the length.
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(hash, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }

  // Only now is the payload trustworthy enough to read.
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate)) return { ok: false, reason: "MALFORMED" };
  const age = Math.floor(Date.now() / 1000) - authDate;
  // A negative age means a clock skew, not an attack, but a payload dated far
  // in the future would otherwise never expire.
  if (age > MAX_AGE_SECONDS || age < -300) return { ok: false, reason: "EXPIRED" };

  let user: TelegramUser;
  try {
    user = JSON.parse(params.get("user") ?? "") as TelegramUser;
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  if (!user || typeof user.id !== "number") return { ok: false, reason: "MALFORMED" };

  return { ok: true, user };
}
