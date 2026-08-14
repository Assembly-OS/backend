import { NextResponse } from "next/server";
import { ADMIN_COOKIE } from "@/lib/admin-auth";

/** Closes the administration session and returns to its own login screen. */
export async function POST(request: Request) {
  const response = NextResponse.redirect(
    new URL("/admin/login", request.url),
    { status: 303 },
  );
  response.cookies.delete(ADMIN_COOKIE);
  return response;
}
