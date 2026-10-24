import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { retrySource, viewSource } from "@/lib/knowledge/sources";
import { id as parseId } from "@/lib/validate";

/** Reads a source again. Anyone who may read it may ask for that. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const sourceId = parseId((await params).id);
  const source = sourceId ? await viewSource(user, sourceId) : undefined;
  if (!source) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  await retrySource(source.id);
  return NextResponse.json({ ok: true });
}
