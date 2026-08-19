import { NextResponse } from "next/server";
import { assertAuthSecret } from "@/lib/auth";
import { get } from "@/lib/pg";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    assertAuthSecret();
    const result = await get<{ ok: number }>("SELECT 1 AS ok");
    if (result?.ok !== 1) throw new Error("database check failed");
    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      { ok: false },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
