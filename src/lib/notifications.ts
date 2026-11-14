import { all, get, now, run } from "./pg";
import { notifyBot } from "./notify-bot";
import { silentSince, silentSql } from "./metrics";

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
  return (
    fired +
    (await sweepKelishuvTerms()) +
    (await sweepSilentTasks()) +
    (await sweepStuckPartners()) +
    (await sweepExpiredProposals()) +
    (await sweepReportCache())
  );
}

/** TZ 8.5: the reports are computed here, not when somebody opens them. */
async function sweepReportCache(): Promise<number> {
  const { refreshReportCache } = await import("./reports");
  return await refreshReportCache();
}

/** TZ 7.1 "eskirish": proposals nobody looked at are archived, by the days in settings. */
async function sweepExpiredProposals(): Promise<number> {
  const { aiSettings } = await import("./settings");
  const { expireProposals } = await import("./agents/orchestrator");
  return await expireProposals((await aiSettings()).expireDays);
}

/* ------------------------------------------------------------------ */
/* Companies stuck on the partnership path (TZ 6.2)                    */
/* ------------------------------------------------------------------ */

const STUCK_LABELS: Record<string, string> = {
  uz: "Hamkorlik qotib qoldi",
  uzc: "Ҳамкорлик қотиб қолди",
  ru: "Партнёрство застряло",
  en: "A partnership is stuck",
};

/**
 * Tells the company's owner when it has sat at a stage past the stage's
 * limit ("Qotib qolgan"). Once per stay: keyed on the moment the stage
 * began, so a move to the next stage closes it and only a new overstay
 * rings again. Companies nobody owns ring the chairman's side instead.
 */
async function sweepStuckPartners(): Promise<number> {
  const { stageLimits } = await import("./settings");
  const { isStuck } = await import("./crm-stages");
  const limits = await stageLimits();
  const rows = await all<{
    id: number;
    name: string;
    stage: keyof typeof limits;
    stage_since: string | null;
    owner_user_id: number | null;
  }>("SELECT id, name, stage, stage_since, owner_user_id FROM partners WHERE stage <> 'CLOSED' AND stage_since IS NOT NULL");
  const today = new Date();
  let fired = 0;
  for (const row of rows) {
    if (!isStuck(row.stage, row.stage_since, limits, today)) continue;
    const recipients = row.owner_user_id
      ? [row.owner_user_id]
      : (await all<{ id: number }>("SELECT id FROM users WHERE role = 'RAIS' AND is_active = 1")).map((u) => u.id);
    for (const userId of recipients) {
      const label = STUCK_LABELS[await langOf(userId)] ?? STUCK_LABELS.uz;
      if (
        await notify({
          userId,
          kind: "agreement",
          title: `${label} · ${row.name}`,
          body: `${row.stage} · ${row.stage_since!.slice(0, 10)}`,
          href: `/companies/${row.id}`,
          // The company in the entity, the stay in the id: a later overstay
          // of the same company is a new notice. The id is the day the
          // stay began, counted from the epoch — small enough for an
          // integer column, unlike a timestamp written out as digits.
          entity: `partner-stuck-${row.id}`,
          entityId: Math.floor(Date.parse(`${row.stage_since!.replace(" ", "T")}Z`) / 86_400_000) || row.id,
          push: true,
        })
      )
        fired++;
    }
  }
  return fired;
}

/* ------------------------------------------------------------------ */
/* Open-ended work gone quiet                                          */
/* ------------------------------------------------------------------ */

const SILENT_LABELS: Record<string, string> = {
  uz: "Topshiriq bo'yicha hisobot kelmadi",
  uzc: "Топшириқ бўйича ҳисобот келмади",
  ru: "По поручению нет отчёта",
  en: "No report on an assignment",
};

/**
 * Tells the person holding an open-ended assignment, and the person who handed
 * it out, when it has gone quiet past its rhythm — TZ block 3.2: "vazifa «Jim»
 * holatiga o'tadi va mas'ul hamda rahbarga bildirishnoma ketadi".
 *
 * Once per silence: the notice is keyed on the moment the report clock last
 * restarted, so a report written today closes this silence, and only a new one
 * after it can ring again.
 */
async function sweepSilentTasks(): Promise<number> {
  const rows = await all<{
    id: number;
    code: string;
    title: string;
    from_user_id: number;
    to_user_id: number;
    since: string;
  }>(
    `SELECT id, code, title, from_user_id, to_user_id, (${silentSince()}) AS since
       FROM tasks
      WHERE ${silentSql()}
      ORDER BY id
      LIMIT 200`,
  );

  let fired = 0;
  for (const row of rows) {
    for (const userId of new Set([row.to_user_id, row.from_user_id])) {
      const label = SILENT_LABELS[await langOf(userId)] ?? SILENT_LABELS.uz;
      const sent = await notify({
        userId,
        kind: "task",
        title: `${label} · ${row.code}`,
        body: row.title,
        href: userId === row.to_user_id ? "/tasks/execute" : "/tasks/assign",
        entity: `task_silent:${row.since}`,
        entityId: row.id,
        push: true,
      });
      if (sent) fired++;
    }
  }
  return fired;
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
