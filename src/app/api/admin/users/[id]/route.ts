import { NextResponse } from "next/server";
import { get, run } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { publish } from "@/lib/events";
import { hasAdminSession } from "@/lib/admin-auth";
import { activeRaisCount, MIN_PASSWORD } from "@/lib/admin";
import { id as parseId, oneOf, str } from "@/lib/validate";
import { DEPARTMENTS, ROLES, type Department, type Role } from "@/lib/types";

interface Target {
  id: number;
  role: Role;
  is_active: number;
}

/**
 * Edits one staff account: profile fields, a new password, or the active flag.
 * Accounts are never deleted — assignments and chat messages reference them, so
 * removing a row would tear holes in the audit trail. Deactivating blocks the
 * login and hides the person from every picker, which is what "remove" means
 * in an org chart.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await hasAdminSession()))
    return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const targetId = parseId((await params).id);
  if (!targetId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const target = get<Target>(
    "SELECT id, role, is_active FROM users WHERE id = ?",
    targetId,
  );
  if (!target) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  const body = (await request.json()) as Record<string, unknown>;
  const action = str(body.action, 20);

  if (action === "toggle") {
    const activate = target.is_active === 0;
    // The Assembly needs a chairman: the last active one stays active. The
    // administrator is not a staff member, so there is no "self" to protect —
    // locking the panel out of its own account is impossible by construction.
    if (!activate && target.role === "RAIS" && activeRaisCount() <= 1)
      return NextResponse.json({ error: "LAST_RAIS" }, { status: 400 });

    run(
      "UPDATE users SET is_active = ? WHERE id = ?",
      activate ? 1 : 0,
      targetId,
    );
    publish(targetId);
    return NextResponse.json({ ok: true, is_active: activate ? 1 : 0 });
  }

  if (action === "password") {
    const password = typeof body.password === "string" ? body.password : "";
    if (password.length < MIN_PASSWORD)
      return NextResponse.json({ error: "WEAK_PASSWORD" }, { status: 400 });

    run(
      "UPDATE users SET password_hash = ? WHERE id = ?",
      hashPassword(password),
      targetId,
    );
    return NextResponse.json({ ok: true });
  }

  if (action === "update") {
    const fullName = str(body.fullName, 120);
    if (!fullName)
      return NextResponse.json({ error: "REQUIRED" }, { status: 400 });

    const role = oneOf(body.role, ROLES, target.role);
    // Same reasoning as above, from the other direction: do not demote the only
    // chairman into a role that cannot hand out work.
    if (target.role === "RAIS" && role !== "RAIS" && activeRaisCount() <= 1)
      return NextResponse.json({ error: "LAST_RAIS" }, { status: 400 });

    const department = DEPARTMENTS.includes(body.department as Department)
      ? (body.department as Department)
      : null;
    const managerId = body.managerId == null ? null : parseId(body.managerId);
    // Nobody reports to themselves, and a manager must exist.
    const manager =
      managerId === null || managerId === targetId
        ? null
        : (get<{ id: number }>(
            "SELECT id FROM users WHERE id = ? AND is_active = 1",
            managerId,
          )?.id ?? null);

    run(
      `UPDATE users SET full_name = ?, role = ?, department = ?, position = ?,
                        manager_id = ?, phone = ?, email = ?
        WHERE id = ?`,
      fullName,
      role,
      department,
      str(body.position, 160),
      manager,
      str(body.phone, 40),
      str(body.email, 120),
      targetId,
    );
    publish(targetId);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "BAD_ACTION" }, { status: 400 });
}
