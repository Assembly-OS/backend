import { crmRole } from "./crm-access";
import { may } from "./permissions";
import type { User } from "./types";

/**
 * Who may do what in a project workspace.
 *
 * The shape of the answer is deliberately not the CRM's. A project is the
 * Assembly's memory of a piece of work, and a memory only exists if the
 * people doing the work write in it — so **anyone signed in may add an entry
 * to any thread**. That is the one permission that had to be wide. A journal
 * only the four managers may write is a journal that records four people's
 * version of events, and the person who actually sat in the meeting is not
 * usually one of them.
 *
 * Everything structural — opening a project, opening or renaming a thread,
 * archiving one — stays with the managers the CRM already trusts. Structure
 * is where a wrong click costs something; a wrong sentence is edited.
 */

/**
 * Opening a project and keeping its threads: whoever TZ 4.2 lets edit a
 * passport. Which project — the chairman any, a project lead his own — is
 * `projectRights` in `project-visibility.ts`; this is the question before
 * there is a project, like the "new project" button.
 */
export function canManageProjects(user: User): boolean {
  return may(user, "editPassport");
}

/**
 * Writing in a thread. Everyone on the staff who can see the project, on
 * purpose — see the note above. Since block 4 "who can see the project" is
 * no longer everyone (`projectRights`), and nobody outside the Assembly
 * writes in the staff's journal.
 */
export function canWriteEntries(rights: { internal: boolean }): boolean {
  return rights.internal;
}

/**
 * Editing or removing one entry.
 *
 * Its author, or an admin. A manager cannot quietly rewrite what a colleague
 * recorded — the value of the journal rests on it being what the person who
 * was there wrote down, and an entry that a third party may edit is worth
 * less as evidence than a note in a pocket.
 */
export function canEditEntry(user: User, authorId: number): boolean {
  return user.id === authorId || crmRole(user) === "admin";
}

/**
 * Pinning is a reading aid, not a change to the record: it marks an entry as
 * worth finding again and alters nothing about it. Anyone who keeps the
 * journal may mark what matters in it.
 */
export function canPinEntry(rights: { internal: boolean }): boolean {
  return canWriteEntries(rights);
}
