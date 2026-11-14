import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { seesEverything } from "@/lib/oversight";
import { importAssociations, parseAssociationCsv } from "@/lib/associations";

/**
 * The fifty associations, from the Assembly's reference list as a CSV
 * (TZ 6.1: "ro'yxat ma'lumotnomada mavjud"). Existing names are updated,
 * new ones created; the response says which. The chairman's side only.
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!seesEverything(user)) return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  let text: string;
  const type = request.headers.get("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File) || file.size === 0 || file.size > 2 * 1024 * 1024)
      return NextResponse.json({ error: "NO_FILE" }, { status: 400 });
    text = await file.text();
  } else {
    const body = (await request.json().catch(() => ({}))) as { csv?: unknown };
    text = typeof body.csv === "string" ? body.csv.slice(0, 2 * 1024 * 1024) : "";
  }

  const parsed = parseAssociationCsv(text);
  if (parsed.rows.length === 0)
    return NextResponse.json({ error: parsed.errors[0] ?? "EMPTY", errors: parsed.errors }, { status: 400 });
  const result = await importAssociations(parsed.rows, user);
  return NextResponse.json({ ok: true, ...result, skipped: parsed.errors });
}
