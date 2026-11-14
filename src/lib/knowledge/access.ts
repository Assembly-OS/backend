import type { Param } from "../pg";
import { canRead } from "../crm-access";
import { meetingScope } from "../meeting-visibility";
import { globalAi } from "../permissions";
import { projectScope } from "../project-visibility";
import { isExternal, type User } from "../types";

/**
 * Who may read which passage — decided at retrieval, against the live tables.
 *
 * The memory copies nothing about permissions. A passage from a task is
 * readable by whoever may open that task *now* (`task-visibility.ts`'s
 * rule), a journal entry by whoever can see its project *now*
 * (`project-visibility.ts`), a meeting by `meeting-visibility.ts`'s scope, a
 * chat line by the people in that conversation and nobody else. The whole
 * rule is one WHERE fragment, applied to every search, every fact lookup and
 * every "read this source" — so the model is never handed a row it then has
 * to be trusted not to repeat.
 *
 * Two choices worth stating. The chairman's global view (TZ 4.2) reaches
 * every record of the Assembly's work, but **not** other people's private
 * conversations: a chat is readable by its participants only, whoever asks.
 * And a library document marked PRIVATE is its uploader's alone, for the
 * same reason.
 */
export function visibleSourcesSql(
  user: User,
  alias = "s",
): { sql: string; params: Param[] } {
  if (!Number.isInteger(user.id)) throw new Error("not a user id");
  const self = String(user.id);
  const global = globalAi(user);
  const external = isExternal(user.role);
  const parts: string[] = [];
  const params: Param[] = [];

  const scope = projectScope(user, "l");
  /** `column` names a project id; true when this person may see that project. */
  const projectVisible = (column: string): string => {
    if (global) return "TRUE";
    params.push(...scope.params);
    return `EXISTS (SELECT 1 FROM loyihalar l WHERE l.id = ${column} AND ${scope.sql})`;
  };

  // The library: by the document's own visibility.
  {
    const clauses = [`d.uploaded_by = ${self}`];
    if (!external) {
      clauses.push("d.visibility = 'ALL'");
      if (global) clauses.push("d.visibility IN ('PROJECT', 'DEPARTMENT')");
      else {
        if (user.department) {
          clauses.push("(d.visibility = 'DEPARTMENT' AND d.department = ?)");
          params.push(user.department);
        }
        clauses.push(`(d.visibility = 'PROJECT' AND ${projectVisible("d.project_id")})`);
      }
    }
    parts.push(
      `(${alias}.kind = 'library' AND EXISTS (SELECT 1 FROM knowledge_documents d
          WHERE d.id = ${alias}.ref_id AND (${clauses.join(" OR ")})))`,
    );
  }

  // Chat: the two people in it, or the group's members. Never widened.
  parts.push(
    `(${alias}.kind = 'message' AND (${alias}.from_user_id = ${self} OR ${alias}.to_user_id = ${self}
        OR (${alias}.group_id IS NOT NULL AND EXISTS (SELECT 1 FROM group_members gm
              WHERE gm.group_id = ${alias}.group_id AND gm.user_id = ${self}))))`,
  );

  // Assignments: `canSeeTask`'s rule, as SQL.
  if (global) parts.push(`${alias}.kind = 'task'`);
  else
    parts.push(
      `(${alias}.kind = 'task' AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = ${alias}.ref_id
          AND (t.from_user_id = ${self} OR t.to_user_id = ${self} OR t.reviewer_user_id = ${self}
               OR EXISTS (SELECT 1 FROM task_stages st WHERE st.task_id = t.id
                           AND (st.to_user_id = ${self} OR st.reviewer_user_id = ${self}))
               OR EXISTS (SELECT 1 FROM users p WHERE p.manager_id = ${self}
                           AND p.id IN (t.from_user_id, t.to_user_id))
               ${external ? "" : `OR (t.loyiha_id IS NOT NULL AND ${projectVisible("t.loyiha_id")})`})))`,
    );

  // The project journal is the staff's (TZ 4.1: an outside lead gets status
  // and report, not the journal).
  if (!external) {
    parts.push(
      global
        ? `${alias}.kind = 'thread_entry'`
        : `(${alias}.kind = 'thread_entry' AND ${projectVisible(`${alias}.project_id`)})`,
    );
  }

  // The passport and its documents: whoever can see the project, outside
  // leads included.
  parts.push(
    global
      ? `${alias}.kind IN ('project', 'project_document')`
      : `(${alias}.kind IN ('project', 'project_document') AND ${projectVisible(`${alias}.project_id`)})`,
  );

  // Meetings: the register's own scope.
  if (global) parts.push(`${alias}.kind = 'meeting'`);
  else {
    const meetings = meetingScope(user, "m");
    if (meetings.sql !== "FALSE") {
      parts.push(
        `(${alias}.kind = 'meeting' AND EXISTS (SELECT 1 FROM meetings m
            WHERE m.id = ${alias}.ref_id AND ${meetings.sql}))`,
      );
      params.push(...meetings.params);
    }
  }

  // Agreements and commitments: the companies base is the staff's (TZ 4.3).
  if (global || canRead(user)) parts.push(`${alias}.kind IN ('kelishuv', 'agreement', 'partner')`);

  // An association's card: the staff read all, an association's own people
  // theirs (TZ 4.2, 6.1 "bir uyushmaning yozuvini boshqasi ko'ra olmaydi").
  if (global || !external) parts.push(`${alias}.kind = 'uyushma'`);
  else if (user.uyushma_id) {
    parts.push(`(${alias}.kind = 'uyushma' AND ${alias}.ref_id = ?)`);
    params.push(user.uyushma_id);
  }

  return { sql: `(${parts.join(" OR ")})`, params };
}
