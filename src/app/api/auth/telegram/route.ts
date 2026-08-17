import { NextResponse } from "next/server";
import { get, run } from "@/lib/db";
import {
  createToken,
  isSecureRequest,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  verifyPassword,
} from "@/lib/auth";
import { check, clientIp, recordFailure, reset } from "@/lib/rate-limit";
import { telegramConfigured, verifyInitData } from "@/lib/telegram";
import type { User } from "@/lib/types";

/**
 * Signing in from inside Telegram.
 *
 * Two things happen here, and which one depends on whether this Telegram
 * account has been seen before.
 *
 *  - **Known account** — `initData` alone is the credential. Telegram signed
 *    it with the bot token, so it proves identity as well as a password does,
 *    and the person is put straight into the platform. Nobody types anything.
 *
 *  - **New account** — the login and password are asked for once. On success
 *    the Telegram id is written against that user, and every later launch
 *    takes the first path.
 *
 * The second half is the point. Linking used to be a `/link <login>
 * <password>` command in the bot, and the result was that not one of the
 * fourteen members of staff had done it — which meant the notification
 * channel, the reminders, the whole Telegram side of the platform, was
 * plumbed in and delivering to nobody. Making the link a by-product of the
 * first sign-in removes the step rather than explaining it.
 */

interface Row extends User {
  password_hash: string;
}

export async function POST(request: Request) {
  if (!telegramConfigured())
    return NextResponse.json({ error: "NOT_CONFIGURED" }, { status: 503 });

  const body = (await request.json()) as {
    initData?: unknown;
    login?: unknown;
    password?: unknown;
  };

  const initData = typeof body.initData === "string" ? body.initData : "";
  const checked = verifyInitData(initData);
  if (!checked.ok) {
    // Rate limited by IP: a forged payload is cheap to generate, and this is
    // the one door where a wrong answer would hand over an account.
    recordFailure(`tg:${clientIp(request)}`);
    return NextResponse.json({ error: checked.reason }, { status: 401 });
  }

  const telegramId = checked.user.id;
  const login = typeof body.login === "string" ? body.login.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  // Already linked: the signature is the whole credential.
  const linked = get<Row>(
    "SELECT * FROM users WHERE telegram_id = ? AND is_active = 1",
    telegramId,
  );
  if (linked) return sessionFor(linked, request, "signed-in");

  // Not linked, and no password offered — tell the client to ask for one
  // rather than failing. This is the normal first launch, not an error.
  if (!login || !password)
    return NextResponse.json({ error: "LINK_REQUIRED" }, { status: 428 });

  const bucket = `tglink:${clientIp(request)}:${login.toLowerCase()}`;
  const limit = check(bucket);
  if (limit.blocked) {
    return NextResponse.json(
      { error: "RATE_LIMIT" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  const user = get<Row>(
    "SELECT * FROM users WHERE login = ? COLLATE NOCASE AND is_active = 1",
    login,
  );
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordFailure(bucket);
    return NextResponse.json({ error: "INVALID" }, { status: 401 });
  }
  reset(bucket);

  // One Telegram account per person. Taking the id off whoever held it before
  // keeps the column unique without a constraint that would fail the login:
  // if somebody re-links from a colleague's phone, the last link wins and the
  // stale one stops receiving another person's notifications.
  run("UPDATE users SET telegram_id = NULL WHERE telegram_id = ?", telegramId);
  run("UPDATE users SET telegram_id = ? WHERE id = ?", telegramId, user.id);

  return sessionFor(user, request, "linked");
}

function sessionFor(user: Row, request: Request, outcome: "signed-in" | "linked") {
  const token = createToken({ uid: user.id, login: user.login, role: user.role });
  const response = NextResponse.json({
    ok: true,
    outcome,
    role: user.role,
    full_name: user.full_name,
  });
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    // The Mini App is a third-party context inside Telegram's webview, so a
    // Lax cookie is not sent back on the navigations that follow. None is
    // required here, and None requires Secure — which the tunnel provides.
    sameSite: isSecureRequest(request) ? "none" : "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return response;
}
