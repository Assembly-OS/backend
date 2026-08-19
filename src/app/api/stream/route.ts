import { currentUser } from "@/lib/session";
import { conversationPartnerIds, pulse, type Pulse } from "@/lib/queries";
import {
  publishPresence,
  subscribe,
  subscribePresence,
  subscribeTyping,
} from "@/lib/events";
import { connect, disconnect, touchLastSeen } from "@/lib/presence";
import { isManager } from "@/lib/types";

// A live connection: never cache it, never let it be treated as static.
export const dynamic = "force-dynamic";

/** Refresh `last_seen` this often while a tab stays open, so it stays recent
 *  even if the server later dies without a clean disconnect. */
const HEARTBEAT_MS = 120_000;

function changed(a: Pulse, b: Pulse): boolean {
  return (
    a.taskRev !== b.taskRev ||
    a.orgRev !== b.orgRev ||
    a.msgRev !== b.msgRev ||
    a.incoming !== b.incoming ||
    a.inWork !== b.inWork ||
    a.onReview !== b.onReview ||
    a.unread !== b.unread
  );
}

/**
 * Server-Sent Events stream that replaces the old polling loops. On connect it
 * emits the current pulse as a baseline; from then on it pushes a fresh `pulse`
 * event the moment any write touches this user's data — instantly, with no
 * interval to wait out. The browser's EventSource reconnects on its own if the
 * socket drops, so there is nothing to retry client-side.
 */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return new Response("AUTH", { status: 401 });

  const encoder = new TextEncoder();
  let last = await pulse(user);

  // Everything the stream needs from the database is resolved before the
  // stream is constructed: an async `start` would postpone the abort handler
  // and leak the heartbeat intervals if the client dropped mid-await.
  const initialPartners = await conversationPartnerIds(user.id);
  const cameOnline = connect(user.id);
  const connectedAt = await touchLastSeen(user.id);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;

      function send(event: string, data: unknown) {
        if (!open) return;
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      }

      // Baseline so the client aligns with server truth immediately.
      send("pulse", last);

      // Whom this user talks to — presence signals about anyone else are noise
      // for them, so we drop those instead of forwarding every user's changes.
      // Managers additionally track org-wide activity (orgRev), so their pulse
      // must be recomputed on any task event, not only ones naming them.
      const manager = isManager(user.role);
      let partners = new Set(initialPartners);

      // A write signals the bus with the ids it touched. Recompute this user's
      // pulse only when it could concern them; skip the query otherwise.
      // The bus does not await listeners, so a failed refresh is swallowed
      // here rather than escaping as an unhandled rejection.
      const onBump = async (userIds: number[]) => {
        if (!manager && !userIds.includes(user.id)) return;
        try {
          const next = await pulse(user);
          if (changed(last, next)) {
            // A new conversation may have started — keep presence routing current.
            const messagesChanged = last.msgRev !== next.msgRev;
            last = next;
            if (messagesChanged) {
              partners = new Set(await conversationPartnerIds(user.id));
            }
            send("pulse", next);
          }
        } catch {
          /* one missed refresh; the next bump recomputes from scratch */
        }
      };
      const unsubscribe = subscribe(onBump);

      // Forward "someone is typing to you" signals, addressed to this user only.
      const unsubscribeTyping = subscribeTyping((signal) => {
        if (signal.to === user.id) send("typing", { from: signal.fromLogin });
      });

      // Presence: announce this user online (once, on the first tab) and relay
      // online/offline changes only for people they actually converse with.
      if (cameOnline) {
        publishPresence({
          id: user.id,
          login: user.login,
          online: true,
          lastSeen: connectedAt,
        });
      }
      const unsubscribePresence = subscribePresence((signal) => {
        if (partners.has(signal.id)) send("presence", signal);
      });

      // A comment line every 25s keeps idle connections from being reaped by
      // browsers or intermediaries. It carries no data and delays nothing.
      const beat = setInterval(() => {
        if (open) controller.enqueue(encoder.encode(": ping\n\n"));
      }, 25000);

      // Keep last_seen fresh while the tab is open (see HEARTBEAT_MS).
      const pulseSeen = setInterval(() => {
        // Fire and forget: a heartbeat that cannot reach the database is not
        // worth tearing the connection down for, but its rejection must not
        // escape the timer callback either.
        if (open) void touchLastSeen(user.id).catch(() => {});
      }, HEARTBEAT_MS);

      const close = () => {
        if (!open) return;
        open = false;
        clearInterval(beat);
        clearInterval(pulseSeen);
        unsubscribe();
        unsubscribeTyping();
        unsubscribePresence();
        // Last tab closed → user is offline; stamp and broadcast the moment.
        const wentOffline = disconnect(user.id);
        if (wentOffline) {
          // The closing stamp is written asynchronously now, and the broadcast
          // must carry the value that was actually stored — so it waits for
          // the write instead of guessing. `close` itself stays synchronous:
          // the controller has to be closed without waiting on the database.
          void touchLastSeen(user.id)
            .then((lastSeen) => {
              publishPresence({
                id: user.id,
                login: user.login,
                online: false,
                lastSeen,
              });
            })
            .catch(() => {});
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      request.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
    },
  });
}
