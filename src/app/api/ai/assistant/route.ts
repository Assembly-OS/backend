import { NextResponse } from "next/server";
import { currentUser, currentLocale } from "@/lib/session";
import { check, clientIp, recordFailure } from "@/lib/rate-limit";
import { askAssistant, type AssistantTurn } from "@/lib/agents/assistant";
import {
  appendExchange,
  chatHistory,
  clearChat,
  CONTEXT_TURNS,
} from "@/lib/agents/assistant-history";
import { str } from "@/lib/validate";

/**
 * One question to the assistant.
 *
 * Rate limited per person rather than per IP: the cost here is a model run
 * with tool calls, and the failure mode being guarded against is somebody
 * holding down enter, not an attacker. Five a minute is far above how fast a
 * person reads an answer and far below anything that would matter on the bill.
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const bucket = `assistant:${clientIp(request)}:${user.id}`;
  const limit = check(bucket, 5, 60_000);
  if (limit.blocked) {
    return NextResponse.json(
      { error: "RATE_LIMIT", retryAfter: limit.retryAfter },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }
  recordFailure(bucket);

  const body = (await request.json()) as { question?: unknown };
  const question = str(body.question, 2000);
  if (!question)
    return NextResponse.json({ error: "EMPTY" }, { status: 400 });

  // The conversation so far comes from the record, not from the browser: two
  // open tabs would otherwise hand the model two different pasts, and a
  // client can claim anything was said.
  const history: AssistantTurn[] = chatHistory(user.id, CONTEXT_TURNS).map(
    (turn) => ({ role: turn.role, content: turn.content }),
  );

  const locale = await currentLocale(user);
  const outcome = await askAssistant(user, locale, history, question);

  if (!outcome.ok) {
    // Three distinct reasons, three distinct HTTP codes — the screen used to
    // report all of them as "the AI key is not configured", including a key
    // that was working a minute earlier.
    const status =
      outcome.reason === "NO_KEY" ? 503 : outcome.reason === "REFUSED" ? 422 : 502;
    return NextResponse.json({ error: outcome.reason }, { status });
  }

  const { answer, refs, steps } = outcome.reply;
  if (!answer) return NextResponse.json({ error: "TOO_COMPLEX" }, { status: 422 });

  // Deduped upstream; capped here so a broad question does not return a wall
  // of links under a three-line answer.
  const shown = refs.slice(0, 12);
  appendExchange(user.id, question, answer, shown);

  return NextResponse.json({ answer, refs: shown, steps });
}

/** Clears this person's conversation. Only ever their own. */
export async function DELETE() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  clearChat(user.id);
  return NextResponse.json({ ok: true });
}
