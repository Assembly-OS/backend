import type { Translator } from "./i18n";

/**
 * SQLite stores `YYYY-MM-DD[ HH:MM:SS]`. A value with a time is an **instant**
 * and is stored in UTC; a value without one is a **calendar date** the user
 * typed (a deadline) and means that day wherever they are.
 *
 * The distinction is the whole of this file's subtlety. Instants must be
 * shifted into the Assembly's own time before anyone reads them — printing the
 * stored string put every timestamp five hours in the past. Calendar dates must
 * not be shifted: a deadline of the 14th is the 14th, and running it through a
 * timezone can only move it to the 13th.
 */

/**
 * Where the Assembly works. Fixed rather than read from the viewer's browser:
 * a task logged at 15:04 in Tashkent is 15:04 in the record, whoever opens it
 * and wherever from — and, since the server renders these pages too, a fixed
 * zone is also what keeps its output identical to the browser's.
 */
const TIME_ZONE = process.env.NEXT_PUBLIC_TIME_ZONE || "Asia/Tashkent";

const LOCAL = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

interface Local {
  day: string;
  month: string;
  year: string;
  hour: string;
  minute: string;
}

/** Splits a stored UTC instant into its parts in Assembly time. */
function localParts(value: string): Local | null {
  const at = new Date(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(at.getTime())) return null;
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of LOCAL.formatToParts(at)) parts[part.type] = part.value;
  if (!parts.year || !parts.day) return null;
  return {
    day: parts.day,
    month: parts.month!,
    year: parts.year,
    hour: parts.hour!,
    minute: parts.minute!,
  };
}

export function formatDate(value: string | null): string {
  if (!value) return "—";
  // No time part: a calendar date, printed as written.
  if (!value.includes(" ")) {
    const [y, m, d] = value.split("-");
    return y && m && d ? `${d}.${m}.${y}` : value;
  }
  const local = localParts(value);
  return local ? `${local.day}.${local.month}.${local.year}` : value;
}

export function formatDateTime(value: string | null): string {
  if (!value) return "—";
  if (!value.includes(" ")) return formatDate(value);
  const local = localParts(value);
  return local
    ? `${local.day}.${local.month}.${local.year} ${local.hour}:${local.minute}`
    : value;
}

/** Chat bubbles: time for today, day+month otherwise. */
export function formatChatTime(value: string): string {
  const local = localParts(value);
  if (!local) return value;
  // "Today" is today in Tashkent, not today in UTC — otherwise messages sent
  // after 05:00 local get stamped with a date for the first five hours.
  const today = localParts(new Date().toISOString().slice(0, 19).replace("T", " "));
  if (
    today &&
    today.year === local.year &&
    today.month === local.month &&
    today.day === local.day
  ) {
    return `${local.hour}:${local.minute}`;
  }
  return `${local.day}.${local.month} ${local.hour}:${local.minute}`;
}

/** `847 KB`, `2.4 MB` — locale-neutral, one decimal only where it informs. */
export function formatBytes(bytes: number | null): string {
  if (!bytes || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** Voice-note length as `m:ss`. */
export function formatDuration(seconds: number | null): string {
  const total = Math.max(0, Math.round(seconds ?? 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function daysUntil(deadline: string | null): number | null {
  if (!deadline) return null;
  const target = new Date(`${deadline.slice(0, 10)}T00:00:00Z`).getTime();
  const today = new Date(
    `${new Date().toISOString().slice(0, 10)}T00:00:00Z`,
  ).getTime();
  return Math.round((target - today) / 86400000);
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function percent(part: number, total: number): number {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("ru-RU").format(Math.round(value));
}

/**
 * Project budgets are stored in millions of so'm. Past a thousand of them the
 * figure stops being readable — "10 030 mln" is really 10 billion — so it rolls
 * up to the next unit. The currency word is left to the caller: some places
 * print it, some only have room for the amount.
 */
export function formatMoney(millions: number, t: Translator): string {
  const [value, unit] =
    millions >= 1_000_000
      ? ([millions / 1_000_000, "stats.trln"] as const)
      : millions >= 1_000
        ? ([millions / 1_000, "stats.bln"] as const)
        : ([millions, "stats.mln"] as const);

  const text = new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);

  return `${text} ${t(unit)}`;
}
