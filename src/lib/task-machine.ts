import type { Task, TaskStatus } from "./types";

/**
 * The task lifecycle as a pure state machine, lifted out of the route handler so
 * it can be unit-tested without a database or a request. The route keeps the
 * SQL side effects; everything about *whether* a transition is legal lives here.
 */
export type TaskAction =
  | "accept"
  | "reject"
  | "start"
  | "submit"
  | "approve"
  | "return";

/** action -> allowed source statuses, resulting status, and who may do it. */
export const TASK_RULES: Record<
  TaskAction,
  { from: TaskStatus[]; to: TaskStatus; actor: "assignee" | "author" }
> = {
  accept: { from: ["YANGI"], to: "QABUL_QILINDI", actor: "assignee" },
  reject: { from: ["YANGI"], to: "RAD_ETILDI", actor: "assignee" },
  start: {
    from: ["QABUL_QILINDI", "QAYTARILDI"],
    to: "BAJARILMOQDA",
    actor: "assignee",
  },
  submit: {
    from: ["QABUL_QILINDI", "BAJARILMOQDA", "QAYTARILDI"],
    to: "TEKSHIRUVDA",
    actor: "assignee",
  },
  approve: { from: ["TEKSHIRUVDA"], to: "BAJARILDI", actor: "author" },
  return: { from: ["TEKSHIRUVDA"], to: "QAYTARILDI", actor: "author" },
};

/** action -> the audit-log event code recorded in task_events. */
export const TASK_EVENT: Record<TaskAction, string> = {
  accept: "QABUL_QILINDI",
  reject: "RAD_ETILDI",
  start: "ISH_BOSHLANDI",
  submit: "TOPSHIRILDI",
  approve: "TASDIQLANDI",
  return: "QAYTARILDI",
};

/** The task fields the machine needs — a subset, so tests can build tiny fakes. */
export type TaskContext = Pick<Task, "status" | "from_user_id" | "to_user_id">;

export type TransitionResult =
  | { ok: true; to: TaskStatus; event: string; actor: "assignee" | "author" }
  | { ok: false; error: "BAD_ACTION" | "FORBIDDEN" | "BAD_STATE" };

function isAction(value: string): value is TaskAction {
  return value in TASK_RULES;
}

/**
 * Decide whether `userId` may apply `action` to `task`:
 *  - BAD_ACTION  — no such transition
 *  - FORBIDDEN   — the user is not the party allowed to act (assignee/author)
 *  - BAD_STATE   — the task is not in a status this action can leave
 * On success, returns the resulting status and audit event.
 */
export function authorizeTransition(
  action: string,
  task: TaskContext,
  userId: number,
): TransitionResult {
  if (!isAction(action)) return { ok: false, error: "BAD_ACTION" };

  const rule = TASK_RULES[action];
  const allowed =
    rule.actor === "assignee"
      ? task.to_user_id === userId
      : task.from_user_id === userId;
  if (!allowed) return { ok: false, error: "FORBIDDEN" };

  if (!rule.from.includes(task.status)) {
    return { ok: false, error: "BAD_STATE" };
  }

  return { ok: true, to: rule.to, event: TASK_EVENT[action], actor: rule.actor };
}
