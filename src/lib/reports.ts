import { all, get, now } from "./pg";
import type { Role } from "./types";

/**
 * The weekly work report: what each person actually did between Monday and
 * Sunday. Everything is counted from `task_events`, the append-only audit log,
 * rather than from a task's current status — a task finished this week and
 * reopened next week must still count as finished *this* week.
 */

/** `YYYY-MM-DD HH:MM:SS` in UTC — the shape every timestamp column uses. */
function stamp(date: Date): string {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
}

export interface WeekBounds {
  /** Inclusive lower bound, as stored (UTC). */
  from: string;
  /** Exclusive upper bound, as stored (UTC). */
  to: string;
  /** `DD.MM` — `DD.MM.YYYY`, for a heading. */
  label: string;
  /** 0 = the current week, -1 = the one before it. */
  offset: number;
}

/**
 * Monday 00:00 to the following Monday 00:00, in the server's local time.
 *
 * Local, not UTC: the Assembly works UTC+5, so a UTC week would start at 05:00
 * Monday local and cut that morning's work into the previous report.
 */
export function weekBounds(offset = 0): WeekBounds {
  const now = new Date();
  const mondayIndex = (now.getDay() + 6) % 7; // Sunday is 0 in JS, Monday is 0 here
  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - mondayIndex + offset * 7,
  );
  const end = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate() + 7,
  );
  const last = new Date(end.getTime() - 86_400_000);

  const dm = (d: Date) =>
    `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;

  return {
    from: stamp(start),
    to: stamp(end),
    label: `${dm(start)} — ${dm(last)}.${last.getFullYear()}`,
    offset,
  };
}

export interface WeeklyRow {
  id: number;
  login: string;
  full_name: string;
  role: Role;
  department: string | null;
  /** Assignments this person handed out during the week. */
  given: number;
  /** Assignments landed in their inbox during the week. */
  received: number;
  accepted: number;
  rejected: number;
  submitted: number;
  /** Their own work approved by the author during the week. */
  done: number;
  /** Their work sent back for rework during the week. */
  returned: number;
  /** Results they approved for other people during the week. */
  approvedForOthers: number;
  /** Still open and past its deadline right now. */
  overdue: number;
  messages: number;
  /** Any audit event at all — the broadest "was this person active" signal. */
  actions: number;
}

export interface WeeklyTotals {
  created: number;
  done: number;
  submitted: number;
  returned: number;
  overdue: number;
  messages: number;
  /** Share of the week's finished work among everything opened, in percent. */
  completion: number;
  /** People with at least one action or message. */
  active: number;
}

export interface WeeklyReport {
  week: WeekBounds;
  rows: WeeklyRow[];
  totals: WeeklyTotals;
}

/**
 * One row per active employee. Counting happens in correlated subqueries
 * rather than a pile of joins: each metric reads a different table with a
 * different predicate, and a join fan-out would multiply the counts.
 */
export async function weeklyReport(offset = 0): Promise<WeeklyReport> {
  const week = weekBounds(offset);
  const { from, to } = week;
  // Postgres has no date('now'); the deadline column is TEXT 'YYYY-MM-DD', so
  // today arrives from JS in the same shape and compares lexicographically.
  const today = now().slice(0, 10);

  const rows = await all<WeeklyRow>(
    `SELECT u.id, u.login, u.full_name, u.role, u.department,
       (SELECT COUNT(*) FROM tasks t
          WHERE t.from_user_id = u.id AND t.created_at >= ? AND t.created_at < ?) AS given,
       (SELECT COUNT(*) FROM tasks t
          WHERE t.to_user_id = u.id AND t.created_at >= ? AND t.created_at < ?) AS received,
       (SELECT COUNT(*) FROM task_events e
          WHERE e.user_id = u.id AND e.action = 'QABUL_QILINDI'
            AND e.created_at >= ? AND e.created_at < ?) AS accepted,
       (SELECT COUNT(*) FROM task_events e
          WHERE e.user_id = u.id AND e.action = 'RAD_ETILDI'
            AND e.created_at >= ? AND e.created_at < ?) AS rejected,
       (SELECT COUNT(*) FROM task_events e
          WHERE e.user_id = u.id AND e.action = 'TOPSHIRILDI'
            AND e.created_at >= ? AND e.created_at < ?) AS submitted,
       -- Approved work is credited to the executor, though the author files
       -- it, and to the executor of the STAGE the event belongs to: once a
       -- chain moves on, t.to_user_id names the next person, and the week
       -- would hand one persons work to another. COALESCE covers every row
       -- written before stages existed, where stage_position is NULL.
       -- (No apostrophes in here: toPlaceholders() tracks quotes character by
       -- character and cannot tell a comment from a string literal.)
       (SELECT COUNT(*) FROM task_events e JOIN tasks t ON t.id = e.task_id
          LEFT JOIN task_stages s ON s.task_id = t.id AND s.position = e.stage_position
          WHERE COALESCE(s.to_user_id, t.to_user_id) = u.id
            AND e.action IN ('TASDIQLANDI','BOSQICH_TASDIQLANDI')
            AND e.created_at >= ? AND e.created_at < ?) AS done,
       (SELECT COUNT(*) FROM task_events e JOIN tasks t ON t.id = e.task_id
          LEFT JOIN task_stages s ON s.task_id = t.id AND s.position = e.stage_position
          WHERE COALESCE(s.to_user_id, t.to_user_id) = u.id
            AND e.action = 'QAYTARILDI'
            AND e.created_at >= ? AND e.created_at < ?) AS returned,
       (SELECT COUNT(*) FROM task_events e
          WHERE e.user_id = u.id AND e.action = 'TASDIQLANDI'
            AND e.created_at >= ? AND e.created_at < ?) AS "approvedForOthers",
       (SELECT COUNT(*) FROM tasks t
          WHERE t.to_user_id = u.id AND t.deadline IS NOT NULL
            AND t.deadline < ?
            AND t.status NOT IN ('BAJARILDI','RAD_ETILDI')) AS overdue,
       (SELECT COUNT(*) FROM messages m
          WHERE m.from_user_id = u.id AND m.created_at >= ? AND m.created_at < ?) AS messages,
       (SELECT COUNT(*) FROM task_events e
          WHERE e.user_id = u.id AND e.created_at >= ? AND e.created_at < ?) AS actions
     FROM users u
     WHERE u.is_active = 1
     ORDER BY done DESC, submitted DESC, u.full_name`,
    // Ten `from`/`to` pairs, in the order the subqueries appear, with `today`
    // threaded in at the position `overdue` occupies: that one asks about
    // right now rather than about the week, so it takes a date, not a range.
    ...Array.from({ length: 8 }, () => [from, to]).flat(),
    today,
    ...Array.from({ length: 2 }, () => [from, to]).flat(),
  );

  const totals = (await get<Omit<WeeklyTotals, "completion" | "active">>(
    `SELECT
       (SELECT COUNT(*) FROM tasks WHERE created_at >= ? AND created_at < ?) AS created,
       -- Both codes: a handover is a stage finished, and leaving it out
       -- would make the organisation total undercount real work.
       (SELECT COUNT(*) FROM task_events WHERE action IN ('TASDIQLANDI','BOSQICH_TASDIQLANDI')
          AND created_at >= ? AND created_at < ?) AS done,
       (SELECT COUNT(*) FROM task_events WHERE action = 'TOPSHIRILDI'
          AND created_at >= ? AND created_at < ?) AS submitted,
       (SELECT COUNT(*) FROM task_events WHERE action = 'QAYTARILDI'
          AND created_at >= ? AND created_at < ?) AS returned,
       (SELECT COUNT(*) FROM tasks WHERE deadline IS NOT NULL AND deadline < ?
          AND status NOT IN ('BAJARILDI','RAD_ETILDI')) AS overdue,
       (SELECT COUNT(*) FROM messages WHERE created_at >= ? AND created_at < ?) AS messages`,
    from,
    to,
    from,
    to,
    from,
    to,
    from,
    to,
    today,
    from,
    to,
  ))!;

  const active = rows.filter(
    (row) => row.actions > 0 || row.messages > 0,
  ).length;

  return {
    week,
    rows,
    totals: {
      ...totals,
      active,
      completion: totals.created
        ? Math.round((totals.done / totals.created) * 100)
        : 0,
    },
  };
}

/**
 * The same report as a plain-text digest for Telegram. Uzbek, matching the
 * platform's default language, and deliberately short: a phone summary that
 * points at the full table on the site rather than reproducing it.
 */
export function renderWeeklyText(report: WeeklyReport, platformUrl = ""): string {
  const { totals, week } = report;
  const lines: string[] = [
    `📊 <b>Haftalik hisobot</b>`,
    `<i>${week.label}</i>`,
    "",
    `Yangi topshiriqlar: <b>${totals.created}</b>`,
    `Bajarildi: <b>${totals.done}</b> (${totals.completion}%)`,
    `Tekshiruvga topshirildi: <b>${totals.submitted}</b>`,
    `Qaytarildi: <b>${totals.returned}</b>`,
    `Muddati o'tgan: <b>${totals.overdue}</b>`,
    `Faol xodimlar: <b>${totals.active}</b>`,
  ];

  // Only people who actually moved something appear by name; a roster of
  // zeroes would bury the signal.
  const worked = report.rows
    .filter((row) => row.done > 0 || row.submitted > 0 || row.actions > 0)
    .slice(0, 12);

  if (worked.length > 0) {
    lines.push("", "<b>Xodimlar bo'yicha</b>");
    for (const row of worked) {
      const parts = [`✅ ${row.done}`, `📤 ${row.submitted}`];
      if (row.returned > 0) parts.push(`↩️ ${row.returned}`);
      if (row.overdue > 0) parts.push(`⏰ ${row.overdue}`);
      lines.push(`• ${row.full_name} — ${parts.join(" · ")}`);
    }
  }

  const idle = report.rows.filter(
    (row) => row.actions === 0 && row.messages === 0,
  );
  if (idle.length > 0) {
    lines.push(
      "",
      `😴 Harakatsiz: ${idle.map((row) => row.full_name).join(", ")}`,
    );
  }

  if (platformUrl) lines.push("", `${platformUrl}/reports`);
  return lines.join("\n");
}
