import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canManageProjects } from "@/lib/project-access";
import { createProject, projectList } from "@/lib/project-threads";
import { PROJECT_PRIORITIES, PROJECT_STATUSES } from "@/lib/projects";
import { id as parseId, oneOf, str } from "@/lib/validate";

/**
 * A malformed date is dropped rather than stored: a deadline nothing can
 * compare against is worse than no deadline at all. Same rule as the CRM.
 */
function isoDay(value: unknown): string | null {
  const day = str(value, 10);
  return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** Every project, with the counts the list needs. Readable by all staff. */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  return NextResponse.json(await projectList());
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canManageProjects(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const body = (await request.json()) as Record<string, unknown>;
  const name = str(body.name, 120);
  if (!name) return NextResponse.json({ error: "REQUIRED" }, { status: 400 });

  const id = await createProject({
    name,
    description: str(body.description, 2000),
    status: oneOf(body.status, PROJECT_STATUSES, "FAOL"),
    priority: oneOf(body.priority, PROJECT_PRIORITIES, "ORTA"),
    stage: str(body.stage, 160),
    deadline: isoDay(body.deadline),
    startedAt: isoDay(body.startedAt),
    // Whoever opens a project answers for it until somebody says otherwise.
    ownerId: body.ownerId == null ? user.id : parseId(body.ownerId),
  });

  return NextResponse.json({ ok: true, id });
}
