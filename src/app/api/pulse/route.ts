import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { pulse } from "@/lib/queries";

/** Polled by <LiveUpdates> a few times a minute — must stay uncached. */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  return NextResponse.json(pulse(user), {
    headers: { "Cache-Control": "no-store" },
  });
}
