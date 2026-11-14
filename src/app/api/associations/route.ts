import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import {
  associations,
  canManageAssociations,
  createAssociation,
  type AssociationInput,
} from "@/lib/associations";
import { readAssociation } from "./input";

/** The associations this person may see. */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  const url = new URL(request.url);
  return NextResponse.json({
    associations: await associations(user, {
      kontur: url.searchParams.get("kontur"),
      status: url.searchParams.get("status"),
      query: url.searchParams.get("q"),
    }),
  });
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canManageAssociations(user)) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const input = readAssociation((await request.json().catch(() => ({}))) as Record<string, unknown>);
  if (!input.name || !input.sector) return NextResponse.json({ error: "REQUIRED" }, { status: 400 });
  const id = await createAssociation(input as AssociationInput, user);
  return NextResponse.json({ ok: true, id }, { status: 201 });
}
