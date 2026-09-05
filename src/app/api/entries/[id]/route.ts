import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canEditEntry, canPinEntry } from "@/lib/project-access";
import {
  deleteEntry,
  editEntry,
  entryById,
  pinEntry,
} from "@/lib/project-threads";
import { id as parseId, str } from "@/lib/validate";

/**
 * Correcting an entry, or marking it as worth finding again.
 *
 * The two actions have different owners and that is the point. Pinning is a
 * reading aid anybody keeping the journal may apply. Editing changes what the
 * record says, and only the person who wrote it — or an admin — may do that:
 * an entry a third party can quietly rewrite is worth less as evidence than a
 * note in a pocket.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const entryId = parseId((await params).id);
  const entry = entryId ? await entryById(entryId) : undefined;
  if (!entry) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const body = (await request.json()) as Record<string, unknown>;

  if (body.action === "pin" || body.action === "unpin") {
    if (!canPinEntry())
      return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
    await pinEntry(entry.id, body.action === "pin");
    return NextResponse.json({ ok: true });
  }

  if (!canEditEntry(user, entry.author_id))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const text = str(body.body, 8000);
  if (!text) return NextResponse.json({ error: "EMPTY" }, { status: 400 });

  const day = str(body.occurredOn, 10);
  await editEntry(
    entry.id,
    text,
    day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null,
  );
  return NextResponse.json({ ok: true });
}

/**
 * Removes the entry and nothing else.
 *
 * Deleting the sentence "they promised the documents by Friday" must not
 * delete the agreement that is chasing Friday: the entry holds a reference to
 * what it produced, never ownership of it.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const entryId = parseId((await params).id);
  const entry = entryId ? await entryById(entryId) : undefined;
  if (!entry) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  if (!canEditEntry(user, entry.author_id))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  await deleteEntry(entry.id);
  return NextResponse.json({ ok: true });
}
