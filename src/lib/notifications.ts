import { all, get, now, run } from "./pg";
import { notifyBot } from "./notify-bot";

/**
 * Notifications — the bell, and what rings it.
 *
 * Two deliveries from one record. The row is the in-app notification a person
 * sees the next time they open the platform; the same event is also pushed to
 * Telegram for the people who linked it, because the reminder that matters is
 * the one that arrives before the deadline, not the one waiting on a page
 * nobody opened.
 *
 * **Firing is idempotent by construction.** A partial unique index on
 * `(user_id, kind, entity, entity_id)` means the same event cannot be announced
 * to the same person twice, whatever calls the sweep or how often. That is what
 * lets `sweepReminders` run from two places at once — the bell endpoint when
 * somebody is online, the bot's minute loop when nobody is — without either
 * needing to know about the other, and without a lock.
 */

export interface Notification {
  id: number;
  kind: string;
  title: string;
  body: string;
  href: string;
  read_at: string | null;
  created_at: string;
}

export interface NotifyInput {
  userId: number;
  kind: "task" | "reminder" | "agreement" | "review" | "meeting";
  title: string;
  body?: string;
  href?: string;
  entity?: string;
  entityId?: number;
  /** Also push to Telegram. Off for chatty, low-stakes events. */
  push?: boolean;
}

/**
 * Records one notification. Returns false when it already existed — which is
 * the normal, expected outcome of a sweep that has already run.
 */
export async function notify(input: NotifyInput): Promise<boolean> {
  const existing =
    input.entity && input.entityId
      ? await get<{ id: number }>(
          `SELECT id FROM notifications
            WHERE user_id = ? AND kind = ? AND entity = ? AND entity_id = ?`,
          input.userId,
          input.kind,
          input.entity,
          input.entityId,
        )
      : undefined;
  if (existing) return false;

  try {
    await run(
      `INSERT INTO notifications
         (user_id, kind, title, body, href, entity, entity_id, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      input.userId,
      input.kind,
      input.title.slice(0, 200),
      (input.body ?? "").slice(0, 1000),
      input.href ?? "/dashboard",
      input.entity ?? null,
      input.entityId ?? null,
      now(),
    );
  } catch {
    // The unique index caught a race between two sweeps. Nothing to do —
    // the other one delivered it.
    return false;
  }

  if (input.push) {
    notifyBot(
      input.userId,
      `🔔 <b>${input.title}</b>${input.body ? `\n${input.body}` : ""}`.slice(0, 3800),
    );
  }
  return true;
}

export async function unreadCount(userId: number): Promise<number> {
  const row = await get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL",
    userId,
  );
  return Number(row?.n ?? 0);
}

export async function listNotifications(
  userId: number,
  limit = 30,
): Promise<Notification[]> {
  return await all<Notification>(
    `SELECT id, kind, title, body, href, read_at, created_at
       FROM notifications WHERE user_id = ?
      ORDER BY read_at IS NOT NULL, id DESC LIMIT ?`,
    userId,
    limit,
  );
}

export async function markRead(userId: number, id?: number): Promise<void> {
  if (id) {
    await run(
      "UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL",
      now(),
      id,
      userId,
    );
    return;
  }
  await run(
    "UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL",
    now(),
    userId,
  );
}

/* ------------------------------------------------------------------ */
/* The sweep                                                           */
/* ------------------------------------------------------------------ */

/**
 * Notification text is written in the recipient's language at the moment it
 * fires, not translated when read: it is also pushed to Telegram, where there
 * is no interface language to consult.
 */
const LABELS: Record<string, { dueToday: string; dueSoon: string }> = {
  uz: { dueToday: "Muddat bugun", dueSoon: "Muddat yaqinlashdi" },
  uzc: { dueToday: "Муддат бугун", dueSoon: "Муддат яқинлашди" },
  ru: { dueToday: "Срок сегодня", dueSoon: "Срок приближается" },
  en: { dueToday: "Due today", dueSoon: "Deadline approaching" },
};

async function labelsFor(userId: number) {
  const lang = (
    await get<{ lang: string | null }>(
      "SELECT lang FROM users WHERE id = ?",
      userId,
    )
  )?.lang;
  return LABELS[lang ?? "uz"] ?? LABELS.uz;
}

interface DueRow {
  id: number;
  user_id: number;
  agreement_id: number | null;
  kind: string;
  message: string;
  description: string | null;
  deadline: string | null;
  company: string | null;
  company_id: number | null;
}

/**
 * Fires every reminder whose time has come.
 *
 * Safe to call from anywhere, as often as anyone likes: a reminder moves
 * `PENDING → SENT` in the same pass that writes its notification, and the
 * unique index catches the case where two callers arrive at once.
 */
export async function sweepReminders(): Promise<number> {
  const due = await all<DueRow>(
    `SELECT r.id, r.user_id, r.agreement_id, r.kind, r.message,
            a.description, a.deadline, a.company_id, p.name AS company
       FROM reminders r
       LEFT JOIN agreements a ON a.id = r.agreement_id
       LEFT JOIN partners p ON p.id = a.company_id
      WHERE r.status = 'PENDING' AND r.remind_at <= ?
      ORDER BY r.remind_at LIMIT 200`,
    now(),
  );

  let fired = 0;
  for (const row of due) {
    // Marked first: a notification that fails to write is a missed ping, but a
    // reminder that stays PENDING after firing is an alarm that repeats every
    // minute until somebody kills the process.
    await run(
      "UPDATE reminders SET status = 'SENT', sent_at = ? WHERE id = ?",
      now(),
      row.id,
    );

    const text = row.description ?? row.message;
    if (!text) continue;

    const when = row.deadline ? ` · ${row.deadline}` : "";
    const labels = await labelsFor(row.user_id);
    await notify({
      userId: row.user_id,
      kind: "reminder",
      title: `${row.kind === "deadline" ? labels.dueToday : labels.dueSoon}${when}`,
      body: [row.company, text].filter(Boolean).join(" — "),
      href: row.company_id ? `/companies/${row.company_id}` : "/agreements",
      entity: "reminder",
      entityId: row.id,
      push: true,
    });
    fired++;
  }
  return fired;
}
