import { NextResponse } from "next/server";
import { hasAdminSession } from "@/lib/admin-auth";
import { createStaffAccount } from "@/lib/staff-admin";

/** Creates a staff account. The administration session is the only key. */
export async function POST(request: Request) {
  if (!(await hasAdminSession()))
    return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const body = (await request.json()) as Record<string, unknown>;
  const { status, body: payload } = await createStaffAccount(body);
  return NextResponse.json(payload, { status });
}
