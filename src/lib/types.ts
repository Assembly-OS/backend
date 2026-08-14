export type Role =
  | "RAIS"
  | "UYUSHMA_RAISI"
  | "LOYIHA_RAHBARI"
  | "BOLIM_RAHBARI"
  | "AI_LAB"
  | "ISHCHI";

export type Department = "GR" | "FR" | "BR" | "PR" | "AI_LAB";

export type TaskStatus =
  | "YANGI"
  | "QABUL_QILINDI"
  | "BAJARILMOQDA"
  | "TEKSHIRUVDA"
  | "BAJARILDI"
  | "QAYTARILDI"
  | "RAD_ETILDI";

export type Priority = "PAST" | "ORTA" | "YUQORI" | "KRITIK";

export type Locale = "uz" | "uzc" | "ru" | "en";

export const ROLES: Role[] = [
  "RAIS",
  "UYUSHMA_RAISI",
  "LOYIHA_RAHBARI",
  "BOLIM_RAHBARI",
  "AI_LAB",
  "ISHCHI",
];

export const DEPARTMENTS: Department[] = ["GR", "FR", "BR", "PR", "AI_LAB"];

export const TASK_STATUSES: TaskStatus[] = [
  "YANGI",
  "QABUL_QILINDI",
  "BAJARILMOQDA",
  "TEKSHIRUVDA",
  "BAJARILDI",
  "QAYTARILDI",
  "RAD_ETILDI",
];

export const PRIORITIES: Priority[] = ["PAST", "ORTA", "YUQORI", "KRITIK"];

export interface User {
  id: number;
  login: string;
  full_name: string;
  role: Role;
  department: Department | null;
  position: string | null;
  uyushma_id: number | null;
  loyiha_id: number | null;
  manager_id: number | null;
  phone: string | null;
  email: string | null;
  lang: Locale;
  is_active: number;
  last_seen: string | null;
  created_at: string;
}

export interface Uyushma {
  id: number;
  name: string;
  short_name: string;
  sector: string;
  region: string;
  members_count: number;
  head_user_id: number | null;
  created_at: string;
}

export interface Loyiha {
  id: number;
  code: string;
  name: string;
  status: string;
  progress: number;
  budget: number;
  owner_id: number | null;
  uyushma_id: number | null;
  deadline: string | null;
  created_at: string;
}

export interface Task {
  id: number;
  code: string;
  title: string;
  description: string | null;
  from_user_id: number;
  to_user_id: number;
  to_department: Department | null;
  priority: Priority;
  status: TaskStatus;
  deadline: string | null;
  loyiha_id: number | null;
  uyushma_id: number | null;
  result_comment: string | null;
  created_at: string;
  accepted_at: string | null;
  submitted_at: string | null;
  closed_at: string | null;
}

export interface TaskRow extends Task {
  from_name: string;
  from_login: string;
  from_role: Role;
  to_name: string;
  to_login: string;
  to_role: Role;
  loyiha_name: string | null;
  /** The author's "fix this" note, live only until the work is resubmitted. */
  return_comment: string | null;
}

/** What a chat row carries: plain text, or one attached blob plus a caption. */
export type MessageKind = "text" | "photo" | "voice" | "file";

export interface Message {
  id: number;
  from_user_id: number;
  to_user_id: number;
  /** The text, or the attachment's caption — empty string when there is none. */
  body: string;
  kind: MessageKind;
  file_name: string | null;
  file_size: number | null;
  file_mime: string | null;
  /** Storage key, server-side only — never serialised to the client. */
  file_key: string | null;
  /** Voice length in seconds. */
  duration: number | null;
  created_at: string;
  read_at: string | null;
}

/** Roles that command a vertical: they may hand out tasks and review results. */
export const MANAGER_ROLES: Role[] = [
  "RAIS",
  "UYUSHMA_RAISI",
  "LOYIHA_RAHBARI",
  "BOLIM_RAHBARI",
  "AI_LAB",
];

export function isManager(role: Role): boolean {
  return MANAGER_ROLES.includes(role);
}

/**
 * The Rais only hands out assignments and accepts results — nobody assigns
 * work to the chairman, so the inbox/execute pages do not apply to that role.
 */
export function receivesTasks(role: Role): boolean {
  return role !== "RAIS";
}

/**
 * Badge tone: a neutral chip, hue carried by the text alone.
 *
 * The earlier scheme filled each chip with its own pastel — seven for status,
 * four for priority — so a single task row could show four saturated
 * rectangles and none of them meant anything more than the others. Colour is a
 * signal; spending it on every chip spends it on nothing. Here the chip is
 * always the page's own surface, and only the word is coloured, which leaves
 * the rose of an overdue critical task as the one thing on the row that shouts.
 */
const CHIP = "bg-[var(--surface)] ring-[var(--line)]";

export function statusTone(status: TaskStatus): string {
  switch (status) {
    // Waiting on someone: no hue, it is the resting state.
    case "YANGI":
      return `${CHIP} muted`;
    case "QABUL_QILINDI":
      return `${CHIP} text-sky-700 dark:text-sky-300`;
    // Work is happening.
    case "BAJARILMOQDA":
      return `${CHIP} text-amber-700 dark:text-amber-300`;
    // Waiting on the manager — the same "needs attention" family.
    case "TEKSHIRUVDA":
      return `${CHIP} text-amber-800 dark:text-amber-200`;
    case "BAJARILDI":
      return `${CHIP} text-emerald-700 dark:text-emerald-300`;
    // Something went wrong and someone has to act.
    case "QAYTARILDI":
    case "RAD_ETILDI":
      return `${CHIP} text-rose-700 dark:text-rose-300`;
  }
}

/**
 * Priority is a modifier, not a state — it stays quiet until it is worth
 * hearing. Normal and low are plain text; only high and critical take colour.
 */
export function priorityTone(priority: Priority): string {
  switch (priority) {
    case "PAST":
    case "ORTA":
      return `${CHIP} muted`;
    case "YUQORI":
      return `${CHIP} text-amber-700 dark:text-amber-300`;
    case "KRITIK":
      return "bg-rose-50 text-rose-700 ring-rose-600/25 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/30";
  }
}
