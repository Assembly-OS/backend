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

export interface Message {
  id: number;
  from_user_id: number;
  to_user_id: number;
  body: string;
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

export function statusTone(status: TaskStatus): string {
  switch (status) {
    case "YANGI":
      return "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-400/30";
    case "QABUL_QILINDI":
      return "bg-indigo-50 text-indigo-700 ring-indigo-600/20 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-400/30";
    case "BAJARILMOQDA":
      return "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/30";
    case "TEKSHIRUVDA":
      return "bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-400/30";
    case "BAJARILDI":
      return "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/30";
    case "QAYTARILDI":
      return "bg-orange-50 text-orange-700 ring-orange-600/20 dark:bg-orange-500/10 dark:text-orange-300 dark:ring-orange-400/30";
    case "RAD_ETILDI":
      return "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/30";
  }
}

export function priorityTone(priority: Priority): string {
  switch (priority) {
    case "PAST":
      return "bg-slate-100 text-slate-600 ring-slate-500/20 dark:bg-slate-500/10 dark:text-slate-300 dark:ring-slate-400/30";
    case "ORTA":
      return "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-400/30";
    case "YUQORI":
      return "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/30";
    case "KRITIK":
      return "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/30";
  }
}
