import { all, run } from "../db";
import type { Ref } from "./assistant";

/**
 * The AI chat's memory.
 *
 * Two jobs from one table. It is what the page shows when it opens — a
 * conversation that survives a refresh, a closed tab and a switch to the
 * phone — and it is the history handed to the model on the next question, so
 * "and what about them?" resolves to whoever was being discussed.
 *
 * Making the server the single source of that history is what keeps the two
 * in step. When the browser sent its own transcript back, the model's memory
 * was whatever happened to be on that screen; two tabs meant two different
 * pasts for the same conversation.
 */

/** Turns kept per person. Beyond this the oldest are dropped. */
const KEEP = 60;

/** Turns replayed to the model. Far shorter — see the note in `askAssistant`. */
export const CONTEXT_TURNS = 8;

export interface StoredTurn {
  id: number;
  role: "user" | "assistant";
  content: string;
  refs: Ref[];
}

interface Row {
  id: number;
  role: string;
  content: string;
  refs: string;
}

function parseRefs(json: string): Ref[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as Ref[]) : [];
  } catch {
    // A row written by an older version, or hand-edited. An answer without
    // its links is still the answer.
    return [];
  }
}

/** The conversation, oldest first — the order it is read in. */
export function chatHistory(userId: number, limit = KEEP): StoredTurn[] {
  const rows = all<Row>(
    `SELECT id, role, content, refs FROM assistant_messages
      WHERE user_id = ? ORDER BY id DESC LIMIT ?`,
    userId,
    limit,
  );
  return rows.reverse().map((row) => ({
    id: row.id,
    role: row.role === "user" ? "user" : "assistant",
    content: row.content,
    refs: parseRefs(row.refs),
  }));
}

/**
 * Records one completed exchange.
 *
 * Both halves together, and only once the answer exists: a question saved on
 * its own would come back after a refresh as something nobody ever replied
 * to, which reads as an answer that was lost rather than one that failed.
 */
export function appendExchange(
  userId: number,
  question: string,
  answer: string,
  refs: Ref[],
): void {
  run(
    "INSERT INTO assistant_messages (user_id, role, content) VALUES (?, 'user', ?)",
    userId,
    question.slice(0, 4000),
  );
  run(
    "INSERT INTO assistant_messages (user_id, role, content, refs) VALUES (?, 'assistant', ?, ?)",
    userId,
    answer.slice(0, 20_000),
    JSON.stringify(refs.slice(0, 12)),
  );
  // Trim here rather than on a schedule: the table only grows when somebody
  // is using it, so the moment of growth is the cheapest moment to prune.
  run(
    `DELETE FROM assistant_messages
      WHERE user_id = ? AND id NOT IN (
        SELECT id FROM assistant_messages WHERE user_id = ? ORDER BY id DESC LIMIT ?
      )`,
    userId,
    userId,
    KEEP,
  );
}

export function clearChat(userId: number): void {
  run("DELETE FROM assistant_messages WHERE user_id = ?", userId);
}
