import { NextResponse } from "next/server";
import { get, run } from "@/lib/db";
import { hasAdminSession } from "@/lib/admin-auth";
import { id as parseId } from "@/lib/validate";
import { codeTaken, PROJECT_CODE_PATTERN, projectFields } from "@/lib/projects";

/**
 * Edits one project. Projects are never deleted: tasks carry `loyiha_id`, so
 * removing the row would leave assignments pointing at nothing. A project that
 * has ended is marked as such through its status instead.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await hasAdminSession()))
    return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const targetId = parseId((await params).id);
  if (!targetId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const target = get<{ id: number; code: string }>(
    "SELECT id, code FROM loyihalar WHERE id = ?",
    targetId,
  );
  if (!target) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const body = (await request.json()) as Record<string, unknown>;
  const fields = projectFields(body);

  if (!fields.code || !fields.name)
    return NextResponse.json({ error: "REQUIRED" }, { status: 400 });
  if (!PROJECT_CODE_PATTERN.test(fields.code))
    return NextResponse.json({ error: "BAD_CODE" }, { status: 400 });
  // A code the project already owns is not a collision.
  if (fields.code !== target.code && codeTaken(fields.code))
    return NextResponse.json({ error: "CODE_TAKEN" }, { status: 409 });

  run(
    `UPDATE loyihalar
        SET code = ?, name = ?, description = ?, status = ?, progress = ?,
            budget = ?, owner_id = ?, deadline = ?, site_no = ?
      WHERE id = ?`,
    fields.code,
    fields.name,
    fields.description,
    fields.status,
    fields.progress,
    fields.budget,
    fields.ownerId,
    fields.deadline,
    fields.siteNo,
    targetId,
  );

  return NextResponse.json({ ok: true });
}
