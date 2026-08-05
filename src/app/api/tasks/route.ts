import { NextResponse } from "next/server";
import { get, now, run } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { publish } from "@/lib/events";
import { notifyBot } from "@/lib/notify-bot";
import { assignableUsers } from "@/lib/queries";
import { id, oneOf, str } from "@/lib/validate";
import { PRIORITIES, type User } from "@/lib/types";

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const body = (await request.json()) as Record<string, unknown>;

  const title = str(body.title, 200);
  const toUserId = id(body.toUserId);
  if (!title || !toUserId) {
    return NextResponse.json({ error: "REQUIRED" }, { status: 400 });
  }

  // The assignment graph is enforced server-side, not just hidden in the form.
  if (!assignableUsers(user).some((candidate) => candidate.id === toUserId)) {
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  }

  const assignee = get<User>("SELECT * FROM users WHERE id = ?", toUserId)!;
  const priority = oneOf(body.priority, PRIORITIES, "ORTA");
  const description = str(body.description, 4000);
  const deadline = str(body.deadline, 20);
  const loyihaId = body.loyihaId == null ? null : id(body.loyihaId);

  const seq =
    Number(get<{ c: number }>("SELECT COUNT(*) AS c FROM tasks")?.c ?? 0) + 1;
  const code = `T-${String(seq).padStart(4, "0")}`;
  const stamp = now();

  run(
    `INSERT INTO tasks (code, title, description, from_user_id, to_user_id, to_department,
                        priority, status, deadline, loyiha_id, uyushma_id, created_at)
     VALUES (?,?,?,?,?,?,?,'YANGI',?,?,?,?)`,
    code,
    title,
    description,
    user.id,
    toUserId,
    assignee.department,
    priority,
    deadline,
    loyihaId,
    assignee.uyushma_id ?? null,
    stamp,
  );

  const taskId = Number(
    get<{ id: number }>("SELECT id FROM tasks WHERE code = ?", code)!.id,
  );
  run(
    "INSERT INTO task_events (task_id, user_id, action, comment, created_at) VALUES (?,?,'YARATILDI',NULL,?)",
    taskId,
    user.id,
    stamp,
  );

  // The assignee's inbox, counters and "new task" toast fire immediately.
  publish(user.id, toUserId);

  // If the assignee linked Telegram (via the bot's /link), ping them there too.
  notifyBot(
    toUserId,
    `🔔 <b>Yangi topshiriq</b> ${code}\n${title}${
      body.deadline ? `\n⏰ ${str(body.deadline, 20)}` : ""
    }`,
  );

  return NextResponse.json({ ok: true, id: taskId, code });
}
