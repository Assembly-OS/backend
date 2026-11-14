import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { relatedHistory } from "@/lib/knowledge/retrieve";
import { id as parseId, str } from "@/lib/validate";

/**
 * The historical reminder (TZ 7.4): what the memory holds about the
 * company, association or project a new record is being filed for, and
 * about its title. Read through the same permission filter as everything
 * else in the memory.
 */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  const q = new URL(request.url).searchParams;
  const items = await relatedHistory(user, {
    companyId: parseId(q.get("company")),
    uyushmaId: parseId(q.get("uyushma")),
    projectId: parseId(q.get("project")),
    text: str(q.get("q"), 200),
  });
  return NextResponse.json({ items });
}
