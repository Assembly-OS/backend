import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { search } from "@/lib/crm";

export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  const query = new URL(request.url).searchParams.get("q") ?? "";
  return NextResponse.json({ hits: await search(query) });
}
