import { get, type Param } from "./pg";
import { canWrite, crmRole } from "./crm-access";
import { may } from "./permissions";
import { isAssociationRole, isExternal, type User } from "./types";

/**
 * Who sees, records and edits which meetings — TZ 4.2's "meeting record" row
 * and 4.3, beside the owner's call on the association chairman.
 *
 * Until block 4 the register was the managers': whoever may write in the CRM
 * read every meeting, and nobody else had the page at all. The TZ gives the
 * row wider: an employee records the meetings he sat in, and an association's
 * representative records his association's. So there are now three scopes:
 *
 *  - the CRM's writers (the chairman's side, department, cluster and project
 *    heads) read the whole register, as before;
 *  - an association's chairman and representative read their association's
 *    meetings — the chairman only reads them (his "overview"), the
 *    representative also files them;
 *  - every other member of staff reads the meetings he filed, answers for, or
 *    was ticked as present at.
 *
 * An outside project lead has no meetings: 4.2's row gives him none.
 */

export type MeetingViewer = Pick<User, "id" | "role" | "login" | "uyushma_id">;

/** Whether the meetings register exists for this person at all. */
export function readsMeetings(user: MeetingViewer): boolean {
  return (
    canWrite(user) ||
    may(user, "createMeeting") ||
    user.role === "UYUSHMA_RAISI"
  );
}

/** Whether this person may file a meeting. */
export function mayRecordMeeting(user: MeetingViewer): boolean {
  // The association chairman's view is an overview: he reads, his
  // representative files.
  return may(user, "createMeeting") && user.role !== "UYUSHMA_RAISI";
}

/** A WHERE fragment limiting `alias` (a `meetings` row) to what `user` may read. */
export function meetingScope(
  user: MeetingViewer,
  alias = "m",
): { sql: string; params: Param[] } {
  if (canWrite(user)) return { sql: "TRUE", params: [] };
  if (isAssociationRole(user.role))
    return { sql: `${alias}.uyushma_id = ?`, params: [user.uyushma_id ?? -1] };
  if (isExternal(user.role)) return { sql: "FALSE", params: [] };
  return {
    sql: `(${alias}.owner_id = ? OR ${alias}.responsible_id = ?
           OR EXISTS (SELECT 1 FROM meeting_staff ms
                       WHERE ms.meeting_id = ${alias}.id AND ms.user_id = ?))`,
    params: [user.id, user.id, user.id],
  };
}

/** Whether this person may read one meeting; false for a missing one too. */
export async function canSeeMeeting(
  user: MeetingViewer,
  meetingId: number,
): Promise<boolean> {
  const scope = meetingScope(user);
  return Boolean(
    await get(
      `SELECT 1 FROM meetings m WHERE m.id = ? AND ${scope.sql}`,
      meetingId,
      ...scope.params,
    ),
  );
}

/**
 * Editing a filed meeting: whoever filed it, whoever answers for its next
 * step, and the chairman's side — among the people who may file meetings at
 * all, so the association chairman's overview stays read-only.
 */
export function mayEditMeeting(
  user: MeetingViewer,
  meeting: { owner_id: number; responsible_id: number | null },
): boolean {
  if (!mayRecordMeeting(user)) return false;
  return (
    meeting.owner_id === user.id ||
    meeting.responsible_id === user.id ||
    crmRole(user) === "admin"
  );
}
