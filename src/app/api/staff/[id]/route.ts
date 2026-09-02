import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canManageStaff } from "@/lib/oversight";
import { deleteStaffAccount, updateStaffAccount } from "@/lib/staff-admin";
import { id as parseId } from "@/lib/validate";

/**
 * Editing a colleague's account, issuing a new password, switching access off,
 * or removing an account created by mistake — from the staff section of the
 * profile page. The rules, including the refusal to sign yourself out, live in
 * `lib/staff-admin.ts`.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canManageStaff(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const targetId = parseId((await params).id);
  if (!targetId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const body = (await request.json()) as Record<string, unknown>;
  const { status, body: payload } = await updateStaffAccount(
    targetId,
    body,
    user.id,
  );
  return NextResponse.json(payload, { status });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canManageStaff(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const targetId = parseId((await params).id);
  if (!targetId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const { status, body } = await deleteStaffAccount(targetId, user.id);
  return NextResponse.json(body, { status });
}
