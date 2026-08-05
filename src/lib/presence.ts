import { now, run } from "./db";

type Global = typeof globalThis & {
  __assambleyaOnline?: Map<number, number>;
};

/**
 * How many live SSE connections each user currently holds. A user is "online"
 * while this is > 0. Parked on globalThis so dev-mode reloads don't wipe it;
 * a real server restart resets it to empty, and clients rebuild it as their
 * EventSource reconnects.
 */
function counts(): Map<number, number> {
  const g = globalThis as Global;
  if (!g.__assambleyaOnline) g.__assambleyaOnline = new Map();
  return g.__assambleyaOnline;
}

/** Record a new connection. Returns true if the user just came online (0 → 1). */
export function connect(userId: number): boolean {
  const map = counts();
  const next = (map.get(userId) ?? 0) + 1;
  map.set(userId, next);
  return next === 1;
}

/** Record a dropped connection. Returns true if the user just went offline. */
export function disconnect(userId: number): boolean {
  const map = counts();
  const next = Math.max(0, (map.get(userId) ?? 0) - 1);
  if (next === 0) map.delete(userId);
  else map.set(userId, next);
  return next === 0;
}

export function isOnline(userId: number): boolean {
  return (counts().get(userId) ?? 0) > 0;
}

/** Ids of everyone with at least one live connection right now. */
export function onlineIds(): number[] {
  return [...counts().keys()];
}

/** Force everyone offline (dev tool) — the map rebuilds as clients reconnect. */
export function clearPresence(): number {
  const map = counts();
  const n = map.size;
  map.clear();
  return n;
}

/** Stamp the user's last activity as "now" and return that timestamp. */
export function touchLastSeen(userId: number): string {
  const stamp = now();
  run("UPDATE users SET last_seen = ? WHERE id = ?", stamp, userId);
  return stamp;
}
