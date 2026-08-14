import { NextResponse } from "next/server";
import { isSecureRequest } from "@/lib/auth";
import {
  ADMIN_COOKIE,
  ADMIN_MAX_AGE,
  checkCredentials,
  createAdminToken,
  isConfigured,
} from "@/lib/admin-auth";
import { check, clientIp, recordFailure, reset } from "@/lib/rate-limit";

/** Opens an administration session. Separate credentials, separate cookie. */
export async function POST(request: Request) {
  const { login, password } = (await request.json()) as {
    login?: string;
    password?: string;
  };

  if (!login?.trim() || !password)
    return NextResponse.json({ error: "EMPTY" }, { status: 400 });

  if (!isConfigured())
    return NextResponse.json({ error: "NOT_CONFIGURED" }, { status: 503 });

  // One bucket for the whole panel: there is a single account, so throttling
  // by IP alone is exactly the protection wanted against a guessing loop.
  const bucket = `admin:${clientIp(request)}`;
  const limit = check(bucket);
  if (limit.blocked)
    return NextResponse.json(
      { error: "RATE_LIMIT" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );

  if (!checkCredentials(login, password)) {
    recordFailure(bucket);
    return NextResponse.json({ error: "INVALID" }, { status: 401 });
  }

  reset(bucket);

  const response = NextResponse.json({ ok: true });
  response.cookies.set(ADMIN_COOKIE, createAdminToken(), {
    httpOnly: true,
    sameSite: "lax",
    // Follows the protocol actually in use — see isSecureRequest.
    secure: isSecureRequest(request),
    path: "/",
    maxAge: ADMIN_MAX_AGE,
  });
  return response;
}
