import Anthropic from "@anthropic-ai/sdk";
import { isConfigured } from "./claude";
import { LEGAL_STATUSES, type PrefillAnswer } from "../meeting-fields";

/**
 * Reads a meeting transcript and proposes the fields of its record — block 1.1
 * of the rebuild TZ: "the AI fills the fields, as a suggestion".
 *
 * A separate call from the meeting analysis in `intake.ts`, on purpose. That
 * one writes the conclusion, the drafted assignments and the memory; this one
 * answers a form. Kept apart, a long analysis cut short cannot take the form's
 * suggestions down with it, and the form can ask for suggestions on a meeting
 * whose analysis ran long ago — or never ran.
 *
 * The model is shown the staff, the projects and the companies by name and
 * answers with those names; `resolveSuggestion` then keeps only what matches a
 * real row. It never writes: what it returns is offered to a person, field by
 * field, and saved only by them.
 */

const MODEL = "claude-opus-5";

export interface PrefillSource {
  title: string;
  transcript: string;
  /** The language speech was recognised in: 'uz-UZ' | 'ru-RU' | 'en-US' | 'auto'. */
  lang: string;
  /** The reviewer's language; the suggested text is written in it. */
  writeIn: "uz" | "uzc" | "ru" | "en";
  /** The Assembly's today, for "today" and "yesterday" in the transcript. */
  today: string;
  staff: { login: string; full_name: string; position: string | null }[];
  projects: { code: string; name: string }[];
  companies: string[];
}

export interface Prefill {
  answer: PrefillAnswer;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

const WRITE_IN: Record<PrefillSource["writeIn"], string> = {
  uz: "Uzbek (latin script)",
  uzc: "Uzbek (cyrillic script)",
  ru: "Russian",
  en: "English",
};

const SCHEMA = {
  type: "object",
  properties: {
    held_at: { type: "string", description: "YYYY-MM-DD or empty" },
    place: { type: "string" },
    company: { type: "string" },
    participants: { type: "string" },
    staff: { type: "array", items: { type: "string" } },
    projects: { type: "array", items: { type: "string" } },
    discussed: { type: "string" },
    agreed: { type: "string" },
    open_issues: { type: "string" },
    next_step: { type: "string" },
    responsible: { type: "string" },
    legal_status: { type: "string", enum: ["", ...LEGAL_STATUSES] },
  },
  required: [
    "held_at",
    "place",
    "company",
    "participants",
    "staff",
    "projects",
    "discussed",
    "agreed",
    "open_issues",
    "next_step",
    "responsible",
    "legal_status",
  ],
  additionalProperties: false,
} as const;

function system(writeIn: PrefillSource["writeIn"]): string {
  return (
    "You fill in meeting records for the Uzbekistan Economy Assembly. From " +
    "the transcript of one meeting, propose each field of its record. A " +
    "person reviews every field before it is saved, so an empty field is " +
    "far better than a guess: answer \"\" (or [] for a list) whenever the " +
    "transcript does not settle a field.\n\n" +
    "The transcript comes from speech recognition and contains errors. Read " +
    "through them; never copy a garbled passage into a field.\n\n" +
    "Fields:\n" +
    "- held_at: the date the meeting itself took place, YYYY-MM-DD, only when " +
    "the transcript says so. Resolve 'today' or 'yesterday' against the date " +
    "given. A deadline or any other date mentioned in passing is not the " +
    "meeting's date.\n" +
    "- place: where the meeting took place, when said.\n" +
    "- company: the main outside organisation the meeting was with. When it " +
    "is in the company list, copy the name exactly as listed; otherwise give " +
    "the name as said. Empty for an internal meeting.\n" +
    "- participants: the people from outside the Assembly, one per line, as " +
    "'Name — position, organisation', with whatever of that was said.\n" +
    "- staff: logins of Assembly staff who took part — from the staff list only.\n" +
    "- projects: codes from the project list the meeting was clearly about — " +
    "from the list only.\n" +
    "- discussed: what was discussed, in 2-5 sentences.\n" +
    "- agreed: only what was actually agreed — decisions and commitments, " +
    "with who, what and by when where said. Not what was merely proposed or " +
    "discussed. Empty when nothing was agreed.\n" +
    "- open_issues: questions left unresolved.\n" +
    "- next_step: the single next action — a first line a person can act on, " +
    "then any detail on the following lines.\n" +
    "- responsible: the login of the staff member who took on the next step — " +
    "from the staff list only; empty when it is not clear.\n" +
    "- legal_status: how far the talks have come. NEGOTIATION: talking, " +
    "nothing in writing. MOU: a memorandum of understanding. LOI: a letter " +
    "of intent. TERM_SHEET: the main terms agreed in writing. CONTRACT: a " +
    "contract signed. STOPPED: the talks were stopped. Only when the " +
    "transcript shows it; a document that is not yet signed is never CONTRACT.\n\n" +
    `Write discussed, agreed, open_issues, next_step and participants in ` +
    `${WRITE_IN[writeIn]}, as a native reader of it would. Keep names, ` +
    "figures and dates exactly as said."
  );
}

function lists(source: PrefillSource): string {
  const staff = source.staff
    .map((person) => `- ${person.login} — ${person.full_name}${person.position ? `, ${person.position}` : ""}`)
    .join("\n");
  const projects = source.projects.map((project) => `- ${project.code} — ${project.name}`).join("\n");
  const companies = source.companies.map((name) => `- ${name}`).join("\n");
  return (
    `Bugun: ${source.today}\nUchrashuv: ${source.title}\n` +
    `Nutq tanilgan til: ${source.lang}\n\n` +
    `Xodimlar:\n${staff || "—"}\n\nLoyihalar:\n${projects || "—"}\n\n` +
    `Kompaniyalar:\n${companies || "—"}`
  );
}

/**
 * The model's proposal for each field, or null. Null on any failure — no key,
 * unreachable, refused, unreadable — because the form works the same without
 * it: the fields are simply left for the person to fill.
 */
export async function suggestMeetingFields(source: PrefillSource): Promise<Prefill | null> {
  if (!isConfigured() || source.transcript.trim().length < 40) return null;
  const client = new Anthropic();

  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      // Twelve short fields, plus room for the thinking that reads a noisy
      // transcript before answering.
      max_tokens: 6000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: {
        // Extraction against a fixed form: `medium` reads a transcript as
        // well as `high` does for this and costs less per press.
        effort: "medium",
        format: { type: "json_schema", schema: SCHEMA },
      },
      system: system(source.writeIn),
      messages: [
        {
          role: "user",
          content:
            `${lists(source)}\n\nBayonnoma (avtomatik tanilgan matn):\n"""\n` +
            `${source.transcript.slice(0, 60_000)}\n"""`,
        },
      ],
    });

    // A policy decline arrives as a normal 200 — check before reading.
    if (response.stop_reason === "refusal") return null;
    const block = response.content.find((item) => item.type === "text");
    if (!block || block.type !== "text") return null;

    let answer: PrefillAnswer;
    try {
      answer = JSON.parse(block.text) as PrefillAnswer;
    } catch {
      return null;
    }
    return {
      answer,
      model: response.model,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
    };
  } catch {
    return null;
  }
}
