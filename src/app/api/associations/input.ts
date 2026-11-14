import type { AssociationInput } from "@/lib/associations";
import { ASSOCIATION_STATUSES, KONTURS } from "@/lib/crm-stages";
import { id as parseId, oneOf, str } from "@/lib/validate";

/** Reads the card's fields from a request body; shared with PATCH. */
export function readAssociation(body: Record<string, unknown>): Partial<AssociationInput> {
  const out: Partial<AssociationInput> = {};
  const text = (key: keyof AssociationInput, max: number) => {
    if (key in body) (out as Record<string, unknown>)[key] = str(body[key], max);
  };
  text("name", 200);
  text("name_uzc", 200);
  text("name_ru", 200);
  text("name_en", 200);
  text("short_name", 80);
  text("sector", 120);
  text("region", 120);
  text("head_name", 160);
  text("head_position", 120);
  text("head_contact", 200);
  if ("kontur" in body) out.kontur = body.kontur ? oneOf(body.kontur, KONTURS, "GR") : null;
  if ("status" in body) out.status = oneOf(body.status, ASSOCIATION_STATUSES, "FAOL");
  if ("responsible_user_id" in body) out.responsible_user_id = parseId(body.responsible_user_id);
  if ("head_user_id" in body) out.head_user_id = parseId(body.head_user_id);
  if ("members_count" in body) {
    const n = Number(body.members_count);
    out.members_count = Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
  }
  if (Array.isArray(body.project_ids))
    out.project_ids = body.project_ids.map(parseId).filter((n): n is number => n !== null).slice(0, 50);
  return out;
}

