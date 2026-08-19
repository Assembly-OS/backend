import { NextResponse } from "next/server";
import { insert, now } from "@/lib/pg";
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
  const fields = await projectFields(body);

  if (!fields.code || !fields.name)
    return NextResponse.json({ error: "REQUIRED" }, { status: 400 });
  if (!PROJECT_CODE_PATTERN.test(fields.code))
    return NextResponse.json({ error: "BAD_CODE" }, { status: 400 });
  if (await codeTaken(fields.code))
    return NextResponse.json({ error: "CODE_TAKEN" }, { status: 409 });

  // RETURNING id rather than reading the row back by code: nothing in the
  // schema makes `code` unique, so a concurrent insert of the same code could
  // hand the caller somebody else's project.
  const id = await insert(
    `INSERT INTO loyihalar
       (code, name, description, status, progress, budget,
        owner_id, uyushma_id, deadline, site_no, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
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
    now(),
  );

  return NextResponse.json({ ok: true, id, code: fields.code });
}
