import { NextResponse } from "next/server";
import { get, run } from "@/lib/pg";
import { currentUser } from "@/lib/session";
import { publish } from "@/lib/events";
import { attach, membersOf, projectRights } from "@/lib/project-visibility";
import { id as parseId } from "@/lib/validate";

type Params = { params: Promise<{ id: string }> };

/**
 * Who is attached to a project — and so who can see it, since block 4 closed
 * projects to everyone else (TZ 4.2).
 *
 * Read by the staff who can see the project. Changed by whoever may edit its
 * passport: attaching someone opens the whole project to them, which is a
 * decision about the project, not a note in its journal. The owner and deputy
 * are attached by those fields on the passport and are not removed here.
 */
export async function GET(_request: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const projectId = parseId((await params).id);
  const rights = projectId ? await projectRights(user, projectId) : null;
  if (!rights?.internal)
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  return NextResponse.json(await membersOf(rights.id));
}

export async function POST(request: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const projectId = parseId((await params).id);
  const rights = projectId ? await projectRights(user, projectId) : null;
  if (!rights?.internal)
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (!rights.editPassport)
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const body = (await request.json()) as Record<string, unknown>;
  const userId = parseId(body.userId);
  const person = userId
    ? await get<{ id: number }>(
        "SELECT id FROM users WHERE id = ? AND is_active = 1",
        userId,
      )
    : undefined;
  if (!person) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  await attach(rights.id, person.id, user.id);
  publish(person.id);
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const projectId = parseId((await params).id);
  const rights = projectId ? await projectRights(user, projectId) : null;
  if (!rights?.internal)
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (!rights.editPassport)
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const userId = parseId(new URL(request.url).searchParams.get("userId"));
  if (!userId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });
  // Leading it is set on the passport; detaching the lead here would leave a
  // project whose owner cannot see it.
  if (userId === rights.owner_id || userId === rights.deputy_id)
    return NextResponse.json({ error: "LEADS_PROJECT" }, { status: 400 });

  await run(
    "DELETE FROM project_members WHERE project_id = ? AND user_id = ?",
    rights.id,
    userId,
  );
  publish(userId);
  return NextResponse.json({ ok: true });
}
