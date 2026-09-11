import { cookies } from "next/headers";
import { DEV_COOKIE, keyMatches } from "./dev-key";

/**
 * Request-side of the hidden dev control panel. The policy it applies lives in
 * `dev-key.ts`, which carries no Next import and is therefore testable.
 */
export { DEV_COOKIE, keyMatches } from "./dev-key";

/** True when the current request carries a valid dev-panel cookie. */
export async function hasDevAccess(): Promise<boolean> {
  const jar = await cookies();
  return keyMatches(jar.get(DEV_COOKIE)?.value);
}
