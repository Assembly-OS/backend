import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { readSource, findFacts } from "@/lib/knowledge/retrieve";
import { id as parseId } from "@/lib/validate";

/**
 * One source as the AI sees it: its passages in order and the facts read
 * from it — for whoever may read the record it came from, which the
 * retrieval layer checks. `from=<position>` continues a long one.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const sourceId = parseId((await params).id);
  if (!sourceId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const from = parseId(new URL(request.url).searchParams.get("from")) ?? 1;
  const text = await readSource(user, sourceId, { from, maxChars: 120_000, maxChunks: 80 });
  if (!text) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const facts = await findFacts(user, { limit: 50 });
  return NextResponse.json({
    ...text,
    facts: facts.filter((fact) => fact.source_id === sourceId),
  });
}
