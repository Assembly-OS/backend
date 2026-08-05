import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

export async function POST() {
  // A RELATIVE Location, not new URL("/login", request.url): behind the
  // cloudflared tunnel request.url is the internal http://localhost:3000, which
  // the Telegram Mini App webview (on the *.trycloudflare.com origin) cannot
  // reach — so logout silently failed there. A relative path resolves against
  // whatever origin the client is actually on.
  const response = new NextResponse(null, {
    status: 303,
    headers: { Location: "/login" },
  });
  response.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return response;
}
