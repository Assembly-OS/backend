import { NextResponse } from "next/server";
import { DEV_COOKIE, keyMatches } from "@/lib/dev-auth";

/**
 * GET /api/dev/unlock?key=<KEY>  → sets the dev cookie and opens the panel.
 * GET /api/dev/unlock?lock=1     → clears it (lock the panel again).
 * A wrong or missing key looks like nothing is here (404), keeping it hidden.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);

  if (url.searchParams.get("lock") === "1") {
    const res = NextResponse.redirect(new URL("/login", url));
    res.cookies.delete(DEV_COOKIE);
    return res;
  }

  const key = url.searchParams.get("key");
  if (!keyMatches(key)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const res = NextResponse.redirect(new URL("/control", url));
  res.cookies.set(DEV_COOKIE, key!, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
