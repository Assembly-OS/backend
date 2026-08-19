import { NextResponse } from "next/server";
import { get, insert, now } from "@/lib/pg";
import { hashPassword } from "@/lib/auth";
import { publish } from "@/lib/events";
import { hasAdminSession } from "@/lib/admin-auth";
import { loginTaken, LOGIN_PATTERN, MIN_PASSWORD } from "@/lib/admin";
import { id, oneOf, str } from "@/lib/validate";
import { DEPARTMENTS, ROLES, type Department } from "@/lib/types";
import { LOCALES } from "@/lib/i18n/config";

/** Creates a staff account. The administration session is the only key. */
export async function POST(request: Request) {
  if (!(await hasAdminSession()))
    return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const body = (await request.json()) as Record<string, unknown>;

  const fullName = str(body.fullName, 120);
  const login = str(body.login, 32)?.toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";

  if (!fullName || !login)
    return NextResponse.json({ error: "REQUIRED" }, { status: 400 });
  if (!LOGIN_PATTERN.test(login))
    return NextResponse.json({ error: "BAD_LOGIN" }, { status: 400 });
  if (password.length < MIN_PASSWORD)
    return NextResponse.json({ error: "WEAK_PASSWORD" }, { status: 400 });
  if (await loginTaken(login))
    return NextResponse.json({ error: "LOGIN_TAKEN" }, { status: 409 });

  const role = oneOf(body.role, ROLES, "ISHCHI");
  const department = DEPARTMENTS.includes(body.department as Department)
    ? (body.department as Department)
    : null;
  const position = str(body.position, 160);
  const phone = str(body.phone, 40);
  const email = str(body.email, 120);
  const lang = oneOf(body.lang, LOCALES, "uz");

  // A manager id is only honoured when it names someone who actually exists.
  const managerId = body.managerId == null ? null : id(body.managerId);
  const manager =
    managerId === null
      ? null
      : ((
          await get<{ id: number }>(
            "SELECT id FROM users WHERE id = ? AND is_active = 1",
            managerId,
          )
        )?.id ?? null);

  // RETURNING rather than a follow-up SELECT: the id comes back with the write,
  // and one round trip fewer counts now that the database is over a socket.
  const created = await insert(
    `INSERT INTO users (login, password_hash, full_name, role, department, position,
                        manager_id, phone, email, lang, is_active, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`,
    login,
    hashPassword(password),
    fullName,
    role,
    department,
    position,
    manager,
    phone,
    email,
    lang,
    now(),
  );

  // The new colleague shows up in everyone's staff directory right away.
  publish(created);

  return NextResponse.json({ ok: true, id: created, login });
}
