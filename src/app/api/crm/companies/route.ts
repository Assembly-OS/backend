import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canWrite } from "@/lib/crm-access";
import { COMPANY_STATUSES, companies, createCompany } from "@/lib/crm";
import { id as parseId, oneOf, str } from "@/lib/validate";

/** The company directory: list with filters, and create. */
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const url = new URL(request.url);
  return NextResponse.json({
    companies: await companies({
      status: url.searchParams.get("status") ?? undefined,
      query: url.searchParams.get("q") ?? undefined,
    }),
  });
}

export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  if (!canWrite(user))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const body = (await request.json()) as Record<string, unknown>;
  const name = str(body.name, 160);
  if (!name) return NextResponse.json({ error: "NAME_REQUIRED" }, { status: 400 });

  const id = await createCompany({
    name,
    description: str(body.description, 2000),
    industry: str(body.industry, 120),
    direction: str(body.direction, 200),
    services: str(body.services, 2000),
    country: str(body.country, 80),
    city: str(body.city, 80),
    address: str(body.address, 300),
    website: str(body.website, 200),
    email: str(body.email, 160),
    phone: str(body.phone, 60),
    head_name: str(body.head_name, 160),
    head_position: str(body.head_position, 120),
    status: oneOf(body.status, COMPANY_STATUSES, "POTENTIAL"),
    started_at: str(body.started_at, 10),
    next_contact_at: str(body.next_contact_at, 10),
    notes: str(body.notes, 4000),
    // Unowned relationships are the ones that go quiet, so the creator owns it
    // unless they name somebody else.
    owner_user_id: parseId(body.owner_user_id) ?? user.id,
  });

  return NextResponse.json({ ok: true, id });
}
