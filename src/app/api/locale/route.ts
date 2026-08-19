import { NextResponse } from "next/server";
import { LOCALES } from "@/lib/i18n/config";
import { LOCALE_COOKIE } from "@/lib/session";
import { currentUser } from "@/lib/session";
import { run } from "@/lib/pg";
import type { Locale } from "@/lib/types";

export async function POST(request: Request) {
  const { locale } = (await request.json()) as { locale?: Locale };
  if (!locale || !LOCALES.includes(locale)) {
    return NextResponse.json({ error: "BAD_LOCALE" }, { status: 400 });
  }

  const user = await currentUser();
  if (user) await run("UPDATE users SET lang = ? WHERE id = ?", locale, user.id);

  const response = NextResponse.json({ ok: true });
  response.cookies.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });
  return response;
}
