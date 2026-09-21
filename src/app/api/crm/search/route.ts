import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { search } from "@/lib/crm";
import { canWrite } from "@/lib/crm-access";

/**
 * Search across meeting transcripts, agreements and assignments. It reads all
 * three unscoped, so since block 4 it answers only the CRM's writers, who
 * read the whole of all three anyway (TZ 4.2); nothing in the app calls it.
 */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canWrite(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  const query = new URL(request.url).searchParams.get("q") ?? "";
  return NextResponse.json({ hits: await search(query) });
}
