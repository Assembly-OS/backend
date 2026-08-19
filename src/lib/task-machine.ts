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
export type TaskContext = Pick<
  Task,
  | "status"
  | "from_user_id"
  | "to_user_id"
  | "current_stage"
  | "stage_count"
  | "reviewer_user_id"
>;

/**
 * Approving the middle of a chain does not close the work — it hands it on.
 *
 * The event codes are separate from `TASDIQLANDI` so the audit log can tell
 * "this task is finished" from "this person's turn is finished".
 */
export const STAGE_APPROVED = "BOSQICH_TASDIQLANDI";
export const STAGE_STARTED = "BOSQICH_BOSHLANDI";

export type TransitionResult =
  | {
      ok: true;
      to: TaskStatus;
      event: string;
      actor: "assignee" | "author";
      /** Present ONLY when the work moves to the next stage. Absent — not
       *  `undefined` — otherwise, because the tests compare whole objects. */
      advance?: true;
    }
  | { ok: false; error: "BAD_ACTION" | "FORBIDDEN" | "BAD_STATE" };

/**
 * Who may approve or return this task right now.
 *
 * The author by default, as it has always been. When a stage names its own
 * reviewer — normally the person whose turn is next — that person approves
 * instead: it lets the work pass straight on without a detour through the
 * author, and lets a return go back to the executor who actually did it.
 */
export function approverOf(task: TaskContext): number {
  return task.reviewer_user_id ?? task.from_user_id;
}

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
      : approverOf(task) === userId;
  if (!allowed) return { ok: false, error: "FORBIDDEN" };

  if (!rule.from.includes(task.status)) {
    return { ok: false, error: "BAD_STATE" };
  }

  // Approving anything but the last stage passes the work on instead of
  // closing it. The status goes back to YANGI because to its new holder the
  // assignment genuinely is new — and because an eighth status value would
  // reach statusTone, the filter strips and four dictionaries for a shade of
  // meaning. accept/reject/start/submit/return are untouched: they act on
  // whoever sits in `to_user_id`, whoever that turns out to be.
  if (action === "approve" && task.current_stage < task.stage_count) {
    return {
      ok: true,
      to: "YANGI",
      event: STAGE_APPROVED,
      actor: "author",
      advance: true,
    };
  }

  return { ok: true, to: rule.to, event: TASK_EVENT[action], actor: rule.actor };
}
