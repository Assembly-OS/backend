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
  kind: "task" | "reminder" | "agreement" | "review" | "meeting" | "project";
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

async function langOf(userId: number): Promise<string> {
  const lang = (
    await get<{ lang: string | null }>(
      "SELECT lang FROM users WHERE id = ?",
      userId,
    )
  )?.lang;
  return lang ?? "uz";
}

async function labelsFor(userId: number) {
  return LABELS[await langOf(userId)] ?? LABELS.uz;
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
  return fired + (await sweepKelishuvTerms());
}

/* ------------------------------------------------------------------ */
/* Agreement terms                                                     */
/* ------------------------------------------------------------------ */

/**
 * Days before an agreement's term ends at which the person answering for it
 * hears about it: a month to arrange a renewal, a week to chase it, and the
 * day itself. TZ block 1.2: "muddat yaqinlashganda eslatma beriladi".
 */
const TERM_NOTICES = [30, 7, 0] as const;

const TERM_LABELS: Record<string, { left: string; today: string }> = {
  uz: { left: "Kelishuv muddati tugashiga {n} kun qoldi", today: "Kelishuv muddati bugun tugaydi" },
  uzc: { left: "Келишув муддати тугашига {n} кун қолди", today: "Келишув муддати бугун тугайди" },
  ru: { left: "Срок соглашения: осталось {n} дн.", today: "Срок соглашения истекает сегодня" },
  en: { left: "Agreement term: {n} days left", today: "An agreement's term ends today" },
};

/**
 * Today in Assembly time. The same rule as `today()` in crm.ts, repeated
 * because crm.ts imports this module and the reverse import would be a cycle.
 */
function assemblyToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: process.env.NEXT_PUBLIC_TIME_ZONE || "Asia/Tashkent",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const DAY_MS = 86_400_000;

/** Calendar days from one 'YYYY-MM-DD' to another; NaN if either is malformed. */
function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  );
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/**
 * Warns whoever answers for an open agreement as its term runs out.
 *
 * Derived, like "expired" itself: nothing is scheduled when the agreement is
 * saved, so a term that is extended, shortened or cleared needs no
 * housekeeping. Each notice is keyed on the term date and the threshold, so
 * the unique index lets every threshold fire once per term — and a renewed
 * term, being a different date, starts again from the top.
 *
 * Only the tightest threshold crossed fires: an agreement entered with five
 * days left gets the week's notice, not the month's and the week's at once.
 * Nobody answering for it means the person who recorded it hears instead.
 */
async function sweepKelishuvTerms(): Promise<number> {
  const day = assemblyToday();
  const rows = await all<{
    id: number;
    title: string;
    valid_until: string;
    user_id: number;
    parties: string | null;
  }>(
    `SELECT k.id, k.title, k.valid_until,
            COALESCE(k.responsible_id, k.created_by) AS user_id,
            (SELECT string_agg(p.name, ', ' ORDER BY p.name)
               FROM kelishuv_parties kp JOIN partners p ON p.id = kp.company_id
              WHERE kp.kelishuv_id = k.id) AS parties
       FROM kelishuvlar k
      WHERE k.status = 'OPEN'
        AND k.valid_until >= ? AND k.valid_until <= ?
        AND COALESCE(k.responsible_id, k.created_by) IS NOT NULL`,
    day,
    addDays(day, TERM_NOTICES[0]),
  );

  let fired = 0;
  for (const row of rows) {
    const left = daysBetween(day, row.valid_until);
    // Ascending, so the first threshold at or above what is left is the
    // tightest one crossed.
    const threshold = [...TERM_NOTICES].reverse().find((n) => left <= n);
    if (threshold === undefined) continue;

    const labels = TERM_LABELS[await langOf(row.user_id)] ?? TERM_LABELS.uz;
    const sent = await notify({
      userId: row.user_id,
      kind: "agreement",
      title: threshold === 0 ? labels.today : labels.left.replace("{n}", String(left)),
      body: [row.title, row.parties].filter(Boolean).join(" — "),
      href: `/agreements/${row.id}`,
      entity: `kelishuv_term:${row.valid_until}:${threshold}`,
      entityId: row.id,
      push: true,
    });
    if (sent) fired++;
  }
  return fired;
}
