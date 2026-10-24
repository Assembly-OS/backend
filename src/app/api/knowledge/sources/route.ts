import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { listSources } from "@/lib/knowledge/sources";
import { isSourceKind } from "@/lib/knowledge/text";
import { id as parseId, str } from "@/lib/validate";

const STATUSES = ["PENDING", "PROCESSING", "READY", "PARTIAL", "FAILED", "SKIPPED", "OPEN"] as const;

/**
 * What the memory holds, as this person may read it: the register of
 * sources with their status, newest first, narrowed by kind, project,
 * author, period, status or title. `before=<id>` pages back.
 */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const url = new URL(request.url);
  const kinds = url.searchParams.getAll("kind").filter(isSourceKind);
  const status = str(url.searchParams.get("status"), 20);
  const result = await listSources(user, {
    kinds: kinds.length ? kinds : undefined,
    projectId: parseId(url.searchParams.get("project")),
    authorId: parseId(url.searchParams.get("author")),
    status: status && (STATUSES as readonly string[]).includes(status) ? (status as (typeof STATUSES)[number]) : null,
    from: dateParam(url.searchParams.get("from")),
    to: dateParam(url.searchParams.get("to")),
    query: str(url.searchParams.get("q"), 100),
    before: parseId(url.searchParams.get("before")),
  });
  return NextResponse.json(result);
}

function dateParam(value: string | null): string | null {
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}
