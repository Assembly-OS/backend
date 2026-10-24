import { all, get } from "../pg";
import { today } from "../crm";
import { projectScope } from "../project-visibility";
import { meetingScope } from "../meeting-visibility";
import { isExternal, type User } from "../types";

/**
 * Questions worth one tap, chosen from what this person's data actually
 * holds: a project they can see, a meeting they were at, work that is late.
 * Each is a template key plus the name to put in it, so the page renders it
 * in the reader's language. A person with nothing in a category gets no
 * question about it rather than a question that would answer "nothing".
 */

export interface Suggestion {
  key:
    | "assistant.s.project"
    | "assistant.s.meeting"
    | "assistant.s.overdue"
    | "assistant.s.person"
    | "assistant.s.document"
    | "assistant.s.decisions"
    | "assistant.s.commitments"
    | "assistant.s.week";
  name?: string;
}

export async function suggestedQuestions(user: User): Promise<Suggestion[]> {
  const out: Suggestion[] = [];

  const scope = projectScope(user, "l");
  const project = await get<{ name: string }>(
    `SELECT l.name FROM loyihalar l
      WHERE ${scope.sql} AND EXISTS (SELECT 1 FROM knowledge_sources s
             WHERE s.project_id = l.id AND s.status IN ('READY','PARTIAL'))
      ORDER BY (SELECT MAX(s.indexed_at) FROM knowledge_sources s WHERE s.project_id = l.id) DESC NULLS LAST
      LIMIT 1`,
    ...scope.params,
  );
  if (project) out.push({ key: "assistant.s.project", name: project.name });

  const meetings = meetingScope(user, "m");
  if (meetings.sql !== "FALSE") {
    const meeting = await get<{ title: string }>(
      `SELECT m.title FROM meetings m WHERE ${meetings.sql}
        ORDER BY COALESCE(m.held_at, m.created_at) DESC LIMIT 1`,
      ...meetings.params,
    );
    if (meeting) out.push({ key: "assistant.s.meeting", name: meeting.title });
  }

  if (!isExternal(user.role)) {
    const overdue = await get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tasks t
        WHERE (t.to_user_id = ? OR t.from_user_id = ?) AND t.deadline IS NOT NULL AND t.deadline < ?
          AND t.status NOT IN ('BAJARILDI', 'RAD_ETILDI')`,
      user.id,
      user.id,
      today(),
    );
    if (Number(overdue?.n ?? 0) > 0) out.push({ key: "assistant.s.overdue" });

    const person = await get<{ full_name: string }>(
      `SELECT u.full_name FROM users u
        WHERE u.is_active = 1 AND u.id <> ? AND (u.manager_id = ? OR u.id = ?)
        ORDER BY (SELECT COUNT(*) FROM tasks t WHERE t.to_user_id = u.id
                   AND t.status NOT IN ('BAJARILDI','RAD_ETILDI')) DESC
        LIMIT 1`,
      user.id,
      user.id,
      user.manager_id ?? -1,
    );
    if (person) out.push({ key: "assistant.s.person", name: person.full_name });
  }

  const documents = await all<{ title: string }>(
    `SELECT s.title FROM knowledge_sources s
      WHERE s.kind IN ('library', 'project_document') AND s.status IN ('READY', 'PARTIAL')
      ORDER BY s.indexed_at DESC LIMIT 1`,
  );
  if (documents[0]) out.push({ key: "assistant.s.document", name: documents[0].title });

  out.push({ key: "assistant.s.decisions" }, { key: "assistant.s.commitments" }, { key: "assistant.s.week" });
  return out.slice(0, 6);
}
