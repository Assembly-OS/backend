import type { Translator } from "./i18n";

/** SQLite stores `YYYY-MM-DD[ HH:MM:SS]`; these helpers stay locale-neutral. */

export function formatDate(value: string | null): string {
  if (!value) return "—";
  const [date] = value.split(" ");
  const [y, m, d] = date.split("-");
  if (!y || !m || !d) return value;
  return `${d}.${m}.${y}`;
}

export function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const [date, time = ""] = value.split(" ");
  return `${formatDate(date)}${time ? ` ${time.slice(0, 5)}` : ""}`;
}

/** Chat bubbles: time for today, day+month otherwise. */
export function formatChatTime(value: string): string {
  const [date, time = "00:00:00"] = value.split(" ");
  const today = new Date().toISOString().slice(0, 10);
  if (date === today) return time.slice(0, 5);
  const [, m, d] = date.split("-");
  return `${d}.${m} ${time.slice(0, 5)}`;
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
