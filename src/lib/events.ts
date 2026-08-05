import { EventEmitter } from "node:events";

type Global = typeof globalThis & { __assambleyaBus?: EventEmitter };

/**
 * A single in-process event bus, parked on globalThis so Next's dev-mode module
 * reloading does not spawn a second emitter (mirrors how the SQLite handle in
 * db.ts is kept). Every write endpoint calls {@link publish}; every open SSE
 * stream in `/api/stream` subscribes, so a change is pushed to clients the
 * instant it lands — no polling interval sits between the write and the screen.
 */
function bus(): EventEmitter {
  const g = globalThis as Global;
  if (!g.__assambleyaBus) {
    const emitter = new EventEmitter();
    // One listener per connected browser tab — no artificial ceiling.
    emitter.setMaxListeners(0);
    g.__assambleyaBus = emitter;
  }
  return g.__assambleyaBus;
}

/**
 * Announce that something changed. The user ids are the people the change
 * touches; today every stream simply recomputes its own pulse on any signal, so
 * they are advisory, but they keep the call sites self-documenting.
 */
export function publish(...userIds: number[]): void {
  bus().emit("bump", userIds);
}

/** Listen for changes. Returns an unsubscribe function. */
export function subscribe(listener: (userIds: number[]) => void): () => void {
  const emitter = bus();
  emitter.on("bump", listener);
  return () => {
    emitter.off("bump", listener);
  };
}

/* ------------------------------------------------------------------ */
/* Typing signals — ephemeral, never touch the database               */
/* ------------------------------------------------------------------ */

export interface TypingSignal {
  /** Who is typing. */
  fromLogin: string;
  /** The user id of the person they are typing to. */
  to: number;
}

/** Announce that one user is typing to another. Carries no persistence. */
export function publishTyping(signal: TypingSignal): void {
  bus().emit("typing", signal);
}

/** Listen for typing signals. Returns an unsubscribe function. */
export function subscribeTyping(
  listener: (signal: TypingSignal) => void,
): () => void {
  const emitter = bus();
  emitter.on("typing", listener);
  return () => {
    emitter.off("typing", listener);
  };
}

/* ------------------------------------------------------------------ */
/* Presence — who is online, and when they were last seen             */
/* ------------------------------------------------------------------ */

export interface PresenceSignal {
  /** User id of the person whose presence changed — used to route the signal. */
  id: number;
  login: string;
  online: boolean;
  /** Last activity timestamp, `YYYY-MM-DD HH:MM:SS` UTC. Null if never seen. */
  lastSeen: string | null;
}

/** Announce that a user came online or went offline. */
export function publishPresence(signal: PresenceSignal): void {
  bus().emit("presence", signal);
}

/** Listen for presence changes. Returns an unsubscribe function. */
export function subscribePresence(
  listener: (signal: PresenceSignal) => void,
): () => void {
  const emitter = bus();
  emitter.on("presence", listener);
  return () => {
    emitter.off("presence", listener);
  };
}
