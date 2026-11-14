import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { associationById, associationCard, canManageAssociations, updateAssociation } from "@/lib/associations";
import { id as parseId } from "@/lib/validate";
import { readAssociation } from "../input";

type Params = { params: Promise<{ id: string }> };

/** One association's card, within the asker's reach (404 outside it). */
export async function GET(_request: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  const id = parseId((await params).id);
  const card = id ? await associationCard(user, id) : undefined;
  if (!card) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ association: card });
}

export async function PATCH(request: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  const id = parseId((await params).id);
  if (!id || !(await associationById(user, id)))
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (!canManageAssociations(user)) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const input = readAssociation((await request.json().catch(() => ({}))) as Record<string, unknown>);
  if (input.name === null || input.sector === null)
    return NextResponse.json({ error: "REQUIRED" }, { status: 400 });
  await updateAssociation(id, input, user);
  return NextResponse.json({ ok: true });
}
