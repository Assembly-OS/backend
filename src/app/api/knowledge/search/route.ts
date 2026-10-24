import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { searchKnowledge } from "@/lib/knowledge/retrieve";
import { isSourceKind } from "@/lib/knowledge/text";
import { id as parseId, str } from "@/lib/validate";

/** A direct search of the memory, for the library page — the same
 *  permission-filtered retrieval the assistant uses, without the model. */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const url = new URL(request.url);
  const query = str(url.searchParams.get("q"), 300);
  if (!query) return NextResponse.json({ hits: [] });
  const kinds = url.searchParams.getAll("kind").filter(isSourceKind);
  const hits = await searchKnowledge(user, query, {
    kinds: kinds.length ? kinds : undefined,
    projectId: parseId(url.searchParams.get("project")),
    limit: 12,
  });
  return NextResponse.json({ hits });
}
