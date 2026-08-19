import { NextResponse } from "next/server";
import { hasAdminSession } from "@/lib/admin-auth";
import { importLegacy, retryImport } from "@/lib/import-legacy";

/**
 * Reports what the boot-time SQLite import did, and retries it on request.
 *
 * The import runs once, in `instrumentation.ts`, before the first request. When
 * it declines or fails it says so in the container's log — which is exactly
 * where nobody can read it: this deployment has no shell. A platform that comes
 * up with an empty database and no explanation is indistinguishable from one
 * that imported nothing because there was nothing to import.
 *
 * GET returns the outcome already reached. POST clears it and tries again,
 * which is safe because the import refuses a database that already holds
 * people — the retry is for after the cause has been fixed, not a second
 * helping.
 */
export async function GET() {
  if (!(await hasAdminSession()))
    return NextResponse.json({ error: "AUTH" }, { status: 401 });

  return NextResponse.json(await importLegacy());
}

export async function POST() {
  if (!(await hasAdminSession()))
    return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const report = await retryImport();
  return NextResponse.json(report, {
    status: report.status === "failed" ? 500 : 200,
  });
}
