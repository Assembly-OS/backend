import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { readToken, SESSION_COOKIE } from "./auth";
import { get } from "./db";
import type { Locale, User } from "./types";
import { LOCALES } from "./i18n/config";

export const LOCALE_COOKIE = "assambleya_locale";

/** Current user, or null when the request carries no valid session. */
export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  const payload = readToken(jar.get(SESSION_COOKIE)?.value);
  if (!payload) return null;
  const user = get<User>(
    "SELECT * FROM users WHERE id = ? AND is_active = 1",
    payload.uid,
  );
  return user ?? null;
}

/** Current user, or a redirect to the login screen. Use in protected pages. */
export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

/** Locale from the cookie, falling back to the user's saved preference. */
export async function currentLocale(user?: User | null): Promise<Locale> {
  const jar = await cookies();
  const fromCookie = jar.get(LOCALE_COOKIE)?.value as Locale | undefined;
  if (fromCookie && LOCALES.includes(fromCookie)) return fromCookie;
  if (user?.lang && LOCALES.includes(user.lang)) return user.lang;
  return "uz";
}
