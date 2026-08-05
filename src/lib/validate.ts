/**
 * Tiny, dependency-free request-body validators. Route handlers receive
 * arbitrary JSON, so every field is coerced through one of these before it
 * reaches a query — trimming, bounding length, and rejecting the wrong shape.
 */

/** A trimmed, non-empty string capped at `max` chars, or null. */
export function str(value: unknown, max = 4000): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

/** A positive integer id (accepts numeric strings), or null. */
export function id(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** `value` if it is one of `allowed`, otherwise `fallback`. */
export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}
