import { NextResponse } from "next/server";
import { get, now, tx } from "@/lib/pg";
import { currentUser } from "@/lib/session";
import { publish } from "@/lib/events";
import { notifyBot } from "@/lib/notify-bot";
import { assignableUsers } from "@/lib/queries";
import { id, oneOf, str } from "@/lib/validate";
import { PRIORITIES, type User } from "@/lib/types";

/** Eight people is already an unusual chain; past that it is a process, not a
 *  task, and the form would be unreadable on a 360px screen. */
const MAX_STAGES = 8;

interface StageInput {
  toUserId: number;
  instruction: string | null;
  /** The next person checks this stage, instead of the author. */
  reviewNext: boolean;
}

/**
 * Normalise the chain the form sent.
 *
 * A plain assignment is a chain of one — there is no "no chain" branch here or
 * anywhere else, which is the whole reason the migration backfilled a stage
 * row for every task that already existed.
 */
function readChain(
  body: Record<string, unknown>,
  toUserId: number | null,
): StageInput[] | null {
  const raw = body.stages;
  if (!Array.isArray(raw) || raw.length === 0) {
    return toUserId ? [{ toUserId, instruction: null, reviewNext: false }] : null;
  }

  const chain: StageInput[] = [];
  for (const entry of raw) {
    const step = entry as Record<string, unknown>;
    const stageUser = id(step.toUserId);
    if (!stageUser) return null;
    chain.push({
      toUserId: stageUser,
      instruction: str(step.instruction, 2000),
      reviewNext: step.reviewNext === true,
    });
  }
  return chain;
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const body = (await request.json()) as Record<string, unknown>;

  const title = str(body.title, 200);
  const chain = readChain(body, id(body.toUserId));
  if (!title || !chain) {
    return NextResponse.json({ error: "REQUIRED" }, { status: 400 });
  }
  if (chain.length > MAX_STAGES) {
    return NextResponse.json({ error: "TOO_MANY_STAGES" }, { status: 400 });
  }

  // Two turns in a row for the same person is a no-op that would still cost
  // them an accept and an approve. Non-adjacent repeats are fine: A → B → A is
  // an ordinary rework loop.
  for (let i = 1; i < chain.length; i++) {
    if (chain[i].toUserId === chain[i - 1].toUserId) {
      return NextResponse.json({ error: "ADJACENT_DUPLICATE" }, { status: 400 });
    }
  }

  // The assignment graph is enforced server-side, not just hidden in the form —
  // and for EVERY person in the chain, or a chain becomes a way to hand work to
  // somebody the author may not hand work to.
  const allowed = new Set(
    (await assignableUsers(user)).map((candidate) => candidate.id),
  );
  if (chain.some((stage) => !allowed.has(stage.toUserId))) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const first = chain[0];
  const assignee = (await get<User>(
    "SELECT * FROM users WHERE id = ?",
    first.toUserId,
  ))!;
  const priority = oneOf(body.priority, PRIORITIES, "ORTA");
  const description = str(body.description, 4000);
  const deadline = str(body.deadline, 20);
  const loyihaId = body.loyihaId == null ? null : id(body.loyihaId);

  // `reviewNext` on the last stage is ignored — there is no next person, so
  // the author approves, as they always did.
  const reviewerOf = (index: number) =>
    chain[index].reviewNext && index + 1 < chain.length
      ? chain[index + 1].toUserId
      : null;

  const seq =
    Number(
      (await get<{ c: number }>("SELECT COUNT(*) AS c FROM tasks"))?.c ?? 0,
    ) + 1;
  const code = `T-${String(seq).padStart(4, "0")}`;
  const stamp = now();

  // One transaction: a task whose stages did not land is a task nobody holds.
  const taskId = await tx(async (q) => {
    // RETURNING, not a read-back by code: `code` comes from a row count, so two
    // concurrent creates can share one, and the read-back could then find either.
    const newId = await q.insert(
      `INSERT INTO tasks (code, title, description, from_user_id, to_user_id, to_department,
                          priority, status, deadline, loyiha_id, uyushma_id, created_at,
                          current_stage, stage_count, reviewer_user_id)
       VALUES (?,?,?,?,?,?,?,'YANGI',?,?,?,?,1,?,?)`,
      code,
      title,
      description,
      user.id,
      first.toUserId,
      assignee.department,
      priority,
      deadline,
      loyihaId,
      assignee.uyushma_id ?? null,
      stamp,
      chain.length,
      reviewerOf(0),
    );

    for (let i = 0; i < chain.length; i++) {
      await q.run(
        `INSERT INTO task_stages (task_id, position, to_user_id, reviewer_user_id,
                                  instruction, status, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        newId,
        i + 1,
        chain[i].toUserId,
        reviewerOf(i),
        chain[i].instruction,
        i === 0 ? "YANGI" : "KUTMOQDA",
        stamp,
      );
    }

    await q.run(
      "INSERT INTO task_events (task_id, user_id, action, comment, created_at, stage_position) VALUES (?,?,'YARATILDI',NULL,?,1)",
      newId,
      user.id,
      stamp,
    );

    return newId;
  });

  // The first assignee's inbox and counters, and everybody else's "coming to
  // you" list, refresh at once.
  publish(user.id, ...chain.map((stage) => stage.toUserId));

  // If the assignee linked Telegram (via the bot's /link), ping them there too.
  // Only the first person: the others get their bell when their turn actually
  // arrives, because three messages at once would read as three assignments.
  notifyBot(
    first.toUserId,
    `🔔 <b>Yangi topshiriq</b> ${code}\n${title}${
      body.deadline ? `\n⏰ ${str(body.deadline, 20)}` : ""
    }`,
  );

  return NextResponse.json({
    ok: true,
    id: taskId,
    code,
    stages: chain.length,
  });
}
