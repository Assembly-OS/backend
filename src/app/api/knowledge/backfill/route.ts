import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { readsAudit } from "@/lib/permissions";
import { enqueueBackfill } from "@/lib/knowledge/sources";
import { isSourceKind } from "@/lib/knowledge/text";

/**
 * Queues every existing record to be read into the memory. Run once after
 * the feature is deployed, and again after a provider is configured; safe
 * to repeat (unchanged records are recognised and skipped). For the two
 * people who read the audit journal — it is an administrative action, and
 * it is written to the journal like one.
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!readsAudit(user.role))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const body = (await request.json().catch(() => ({}))) as { kinds?: unknown };
  const kinds = Array.isArray(body.kinds) ? body.kinds.filter(isSourceKind) : undefined;
  const queued = await enqueueBackfill(kinds?.length ? kinds : undefined);
  return NextResponse.json({ queued });
}
