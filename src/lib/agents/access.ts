import type { User } from "@/lib/types";

/**
 * Who may hand material to the intake agents.
 *
 * The brief was "department heads, Muslimbek, and the Rais". Muslimbek is the
 * chairman's assistant and already carries BOLIM_RAHBARI, so the rule is the
 * two roles rather than a name — a hard-coded login would silently stop
 * working the day that person changes.
 *
 * The narrower rule that actually protects anything is elsewhere: whatever an
 * agent drafts can only ever name someone `assignableUsers()` already lets
 * this person assign to.
 */
export function canSubmitToAi(user: User): boolean {
  return user.role === "RAIS" || user.role === "BOLIM_RAHBARI";
}
