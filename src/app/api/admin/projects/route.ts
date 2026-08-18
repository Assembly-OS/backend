import { NextResponse } from "next/server";
import { get, run } from "@/lib/db";
import { hasAdminSession } from "@/lib/admin-auth";
import { codeTaken, PROJECT_CODE_PATTERN, projectFields } from "@/lib/projects";

/**
 * Creates a project. The administration session is the only key, exactly as
 * for staff: projects are reference data the whole platform points at, so
 * changing the list is an administrative act rather than day-to-day work.
 */
export async function POST(request: Request) {
  if (!(await hasAdminSession()))
    return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const body = (await request.json()) as Record<string, unknown>;
  const fields = projectFields(body);

  if (!fields.code || !fields.name)
    return NextResponse.json({ error: "REQUIRED" }, { status: 400 });
  if (!PROJECT_CODE_PATTERN.test(fields.code))
    return NextResponse.json({ error: "BAD_CODE" }, { status: 400 });
  if (codeTaken(fields.code))
    return NextResponse.json({ error: "CODE_TAKEN" }, { status: 409 });

  run(
    `INSERT INTO loyihalar
       (code, name, description, status, progress, budget,
        owner_id, uyushma_id, deadline, site_no, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))`,
    fields.code,
    fields.name,
    fields.description,
    fields.status,
    fields.progress,
    fields.budget,
    fields.ownerId,
    null,
    fields.deadline,
    fields.siteNo,
  );

  const created = get<{ id: number }>(
    "SELECT id FROM loyihalar WHERE code = ?",
    fields.code,
  )!;

  return NextResponse.json({ ok: true, id: created.id, code: fields.code });
}
