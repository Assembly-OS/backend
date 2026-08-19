import fs from "node:fs";
import path from "node:path";
import { all, get } from "./pg";
import { onlineIds } from "./presence";
import type { Role, TaskStatus } from "./types";

const DB_DIR = path.join(process.cwd(), "data");

function fileSize(name: string): number {
  try {
    return fs.statSync(path.join(DB_DIR, name)).size;
  } catch {
    return 0;
  }
}

const TABLES = [
  "users",
  "uyushmalar",
  "loyihalar",
  "tasks",
  "task_events",
  "messages",
] as const;

export interface DbStats {
  files: { db: number; wal: number; shm: number };
  counts: Record<string, number>;
  byStatus: { status: TaskStatus; count: number }[];
}

export async function dbStats(): Promise<DbStats> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    counts[table] = Number(
      (await get<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table}`))?.c ?? 0,
    );
  }
  const byStatus = await all<{ status: TaskStatus; count: number }>(
    "SELECT status, COUNT(*) AS count FROM tasks GROUP BY status ORDER BY count DESC",
  );
  return {
    files: {
      db: fileSize("assambleya.db"),
      wal: fileSize("assambleya.db-wal"),
      shm: fileSize("assambleya.db-shm"),
    },
    counts,
    byStatus,
  };
}

export interface OnlineUser {
  id: number;
  login: string;
  full_name: string;
  role: Role;
}

export async function onlineUsers(): Promise<OnlineUser[]> {
  const ids = onlineIds();
  if (ids.length === 0) return [];
  const marks = ids.map(() => "?").join(",");
  return all<OnlineUser>(
    `SELECT id, login, full_name, role FROM users WHERE id IN (${marks}) ORDER BY full_name`,
    ...ids,
  );
}

export interface DevEvent {
  id: number;
  action: string;
  created_at: string;
  code: string;
  actor: string;
}

export async function recentEvents(limit = 20): Promise<DevEvent[]> {
  return all<DevEvent>(
    `SELECT e.id, e.action, e.created_at, t.code, u.full_name AS actor
       FROM task_events e
       JOIN tasks t ON t.id = e.task_id
       JOIN users u ON u.id = e.user_id
      ORDER BY e.id DESC
      LIMIT ?`,
    limit,
  );
}

export interface AdminUser {
  id: number;
  login: string;
  full_name: string;
  role: Role;
  department: string | null;
  is_active: number;
  last_seen: string | null;
}

export async function adminUsers(): Promise<AdminUser[]> {
  return all<AdminUser>(
    `SELECT id, login, full_name, role, department, is_active, last_seen
       FROM users ORDER BY is_active DESC, full_name`,
  );
}

export interface AdminTask {
  id: number;
  code: string;
  title: string;
  status: TaskStatus;
  from_user_id: number;
  to_user_id: number;
  from_name: string;
  to_name: string;
  created_at: string;
}

export async function adminTasks(limit = 40): Promise<AdminTask[]> {
  return all<AdminTask>(
    `SELECT t.id, t.code, t.title, t.status, t.from_user_id, t.to_user_id,
            f.full_name AS from_name, s.full_name AS to_name, t.created_at
       FROM tasks t
       JOIN users f ON f.id = t.from_user_id
       JOIN users s ON s.id = t.to_user_id
      ORDER BY t.id DESC
      LIMIT ?`,
    limit,
  );
}

export interface SystemInfo {
  env: string;
  node: string;
  uptimeSec: number;
  version: string;
}

export function systemInfo(): SystemInfo {
  let version = "?";
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    ) as { version?: string };
    version = pkg.version ?? "?";
  } catch {
    /* ignore */
  }
  return {
    env: process.env.NODE_ENV ?? "development",
    node: process.version,
    uptimeSec: Math.round(process.uptime()),
    version,
  };
}

/** Compact assignee options for the reassign control. */
export async function assigneeOptions(): Promise<
  { id: number; label: string }[]
> {
  return (
    await all<{ id: number; login: string; full_name: string }>(
      "SELECT id, login, full_name FROM users WHERE is_active = 1 ORDER BY full_name",
    )
  ).map((u) => ({ id: u.id, label: `${u.full_name} (@${u.login})` }));
}
