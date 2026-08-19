import { NextResponse } from "next/server";
import { get } from "@/lib/pg";
import {
  createToken,
  isSecureRequest,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  verifyPassword,
} from "@/lib/auth";
import { check, clientIp, recordFailure, reset } from "@/lib/rate-limit";
import type { User } from "@/lib/types";

interface Row extends User {
  password_hash: string;
}

export async function POST(request: Request) {
  const { login, password } = (await request.json()) as {
    login?: string;
    password?: string;
  };

  if (!login?.trim() || !password) {
    return NextResponse.json({ error: "EMPTY" }, { status: 400 });
  }

  // Throttle brute force: bucket by IP + login so guessing one account cannot
  // lock out others, and a shared IP cannot be starved by one target.
  const bucket = `${clientIp(request)}:${login.trim().toLowerCase()}`;
  const limit = check(bucket);
  if (limit.blocked) {
    return NextResponse.json(
      { error: "RATE_LIMIT" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  const user = await get<Row>(
    "SELECT * FROM users WHERE lower(login) = lower(?) AND is_active = 1",
    login.trim(),
  );

  if (!user || !verifyPassword(password, user.password_hash)) {
    recordFailure(bucket);
    return NextResponse.json({ error: "INVALID" }, { status: 401 });
  }

  // A clean login clears the strike count for this bucket.
  reset(bucket);

  const token = createToken({
    uid: user.id,
    login: user.login,
    role: user.role,
  });

  const response = NextResponse.json({ ok: true, role: user.role });
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return response;
}
