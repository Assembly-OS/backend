type Global = typeof globalThis & {
  __assambleyaAttempts?: Map<string, number[]>;
};

/** Failed-attempt timestamps per key, parked on globalThis to survive dev reloads. */
function store(): Map<string, number[]> {
  const g = globalThis as Global;
  if (!g.__assambleyaAttempts) g.__assambleyaAttempts = new Map();
  return g.__assambleyaAttempts;
}

export interface LimitState {
  /** Whether the key is currently locked out. */
  blocked: boolean;
  /** Seconds until the oldest attempt ages out (only meaningful when blocked). */
  retryAfter: number;
  /** Attempts still allowed before lockout. */
  remaining: number;
}

/**
 * Sliding-window limiter for authentication. It counts only *failed* attempts
 * (call {@link recordFailure} on a bad password, {@link reset} on success), so a
 * user who logs in correctly is never throttled, while a password-guessing loop
 * is stopped after `limit` misses within `windowMs`.
 */
export function check(
  key: string,
  limit = 5,
  windowMs = 15 * 60 * 1000,
): LimitState {
  const now = Date.now();
  const fresh = (store().get(key) ?? []).filter((t) => now - t < windowMs);
  store().set(key, fresh);

  const blocked = fresh.length >= limit;
  const retryAfter = blocked
    ? Math.ceil((windowMs - (now - fresh[0])) / 1000)
    : 0;
  return { blocked, retryAfter, remaining: Math.max(0, limit - fresh.length) };
}

export function recordFailure(key: string): void {
  const list = store().get(key) ?? [];
  list.push(Date.now());
  store().set(key, list);
}

export function reset(key: string): void {
  store().delete(key);
}

/** Best-effort client IP from proxy headers, falling back to a shared bucket. */
export function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip")?.trim() || "local";
}
