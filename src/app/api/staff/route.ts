import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canManageStaff } from "@/lib/oversight";
import { createStaffAccount } from "@/lib/staff-admin";

/**
 * Adding a colleague from inside the platform.
 *
 * Same writes as the `/admin` route beside it, a different door: this one is
 * opened by an ordinary session belonging to someone `canManageStaff` allows —
 * the chairman and his assistant — rather than by the panel's separate
 * password.
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canManageStaff(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const body = (await request.json()) as Record<string, unknown>;
  const { status, body: payload } = await createStaffAccount(body);
  return NextResponse.json(payload, { status });
}
