import { NextResponse } from "next/server";
import { get, run } from "@/lib/db";
import { currentUser } from "@/lib/session";
import { hashPassword, verifyPassword } from "@/lib/auth";

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const { oldPassword, newPassword } = (await request.json()) as {
    oldPassword?: string;
    newPassword?: string;
  };

  if (!newPassword || newPassword.length < 6) {
    return NextResponse.json({ error: "SHORT" }, { status: 400 });
  }

  const row = get<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE id = ?",
    user.id,
  );
  if (!row || !verifyPassword(oldPassword ?? "", row.password_hash)) {
    return NextResponse.json({ error: "WRONG_PASSWORD" }, { status: 403 });
  }

  run(
    "UPDATE users SET password_hash = ? WHERE id = ?",
    hashPassword(newPassword),
    user.id,
  );
  return NextResponse.json({ ok: true });
}
