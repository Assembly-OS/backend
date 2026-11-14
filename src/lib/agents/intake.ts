import Anthropic from "@anthropic-ai/sdk";
import { isConfigured } from "./claude";
import { memoryBlock, type MemoryFact } from "./live";
import { partnerHistory, type PartnerReport } from "./partners";
import type { ExtractedSource } from "./extract";

/**
 * The two agents that work from something a person hands in: a PDF (Document
 * Agent) and a meeting transcript (Meeting Agent).
 *
 * These differ from the monitoring agents in one important way. There, the
 * model only rewrote facts that code had already established. Here the source
 * *is* free text, so the model genuinely extracts — and everything it extracts
 * is therefore treated as a draft:
 *
 *  - it may only name an assignee from a list of real logins passed in, and any
 *    name it invents is dropped by the caller before anything is stored;
 *  - nothing it proposes is executed. Every extracted task waits as a
 *    `suggest_task` proposal until the person who submitted the file approves
 *    it, which is TZ §16 AI-03 applied to the case that matters most.
 */

const MODEL = "claude-opus-5";

export interface DraftTask {
  title: string;
  description: string;
  /** Login of the proposed owner; validated against the real staff list. */
  assignee: string;
  priority: "PAST" | "ORTA" | "YUQORI" | "KRITIK";
  /** `YYYY-MM-DD`, or empty when the source gives no date. */
  deadline: string;
  /** Why this person — quoted or paraphrased from the source. */
  rationale: string;
}

/** An agreement's card as a draft (TZ 7.2 "Imzolangan hujjat → kelishuv kartasi"). */
export interface KelishuvDraft {
  title: string;
  kind: "MOU" | "LOI" | "TERM_SHEET" | "CONTRACT" | "PROTOCOL" | "OTHER";
  content: string;
  /** Company names as the document writes them; matched to the base later. */
  parties: string[];
  amount: number;
  currency: "UZS" | "USD" | "EUR" | "";
  signed_on: string;
  valid_until: string;
  obligations: { description: string; owner: string; deadline: string }[];
  rationale: string;
}

/** A company the source names that the base does not hold yet. */
export interface CompanyDraft {
  name: string;
  industry: string;
  description: string;
  head_name: string;
  head_position: string;
  country: string;
  city: string;
  website: string;
  rationale: string;
}

/** A company's move along the partnership path the source justifies. */
export interface StageDraft {
  company: string;
  stage: "NEW_CONTACT" | "CONTACT" | "MEETING" | "PROPOSAL" | "NEGOTIATION" | "AGREEMENT" | "ACTIVE" | "MONITORING" | "CLOSED";
  rationale: string;
}

/** A project's phase a report says it has reached. */
export interface PhaseDraft {
  project: string;
  phase: "CONCEPT" | "FEASIBILITY" | "PREPARATION" | "EXECUTION" | "MONITORING" | "CLOSED" | "FROZEN";
  rationale: string;
}

export interface RecordDrafts {
  kelishuvlar: KelishuvDraft[];
  companies: CompanyDraft[];
  stageUpdates: StageDraft[];
  phaseUpdates: PhaseDraft[];
}

/** What the base already holds, so drafts name real companies and projects. */
export interface IntakeContext {
  companies: { id: number; name: string; stage: string }[];
  projects: { id: number; code: string; name: string; phase: string | null }[];
}

export const DOCUMENT_KINDS = ["ORDER", "LETTER", "SIGNED", "REPORT", "OTHER"] as const;

export interface DocumentAnalysis extends RecordDrafts {
  documentTitle: string;
  /** What the document is: an order or minutes, a letter or proposal, a signed agreement, a project report. */
  kind: (typeof DOCUMENT_KINDS)[number];
  summary: string;
  tasks: DraftTask[];
  model: string;
  tokensIn: number;
  tokensOut: number;
}

/**
 * The same sentence in the three languages the Assembly reads.
 *
 * Produced in one pass rather than translated afterwards: a translator working
 * from the Uzbek summary alone would be guessing at the meeting behind it, and
 * would carry any mishearing straight into the other two languages.
 */
export interface Trilingual {
  uz: string;
  ru: string;
  en: string;
}

/** The row a reader gets, in whichever language they are reading. */
export function pick(value: Trilingual | undefined, lang: string): string {
  if (!value) return "";
  // Cyrillic Uzbek is the same language in another script; it reads the latin.
  if (lang === "ru") return value.ru || value.uz;
  if (lang === "en") return value.en || value.uz;
  return value.uz || value.ru || value.en;
}

export interface MeetingAnalysis {
  summary: Trilingual;
  keyPoints: Trilingual[];
  decisions: Trilingual[];
  tasks: DraftTask[];
  /** What this meeting should still be known for a month from now. */
  memory: MemoryFact[];
  /** The companies this meeting was about, and what to propose them next. */
  partners: PartnerReport[];
  /** An agreement drafted from what was agreed, when something was (TZ 7.2). */
  kelishuvlar: KelishuvDraft[];
  /** Companies met that the base does not hold yet. */
  companies: CompanyDraft[];
  model: string;
  tokensIn: number;
  tokensOut: number;
}

export interface Candidate {
  login: string;
  full_name: string;
  role: string;
  department: string | null;
  position: string | null;
}

const TASK_ITEM = {
  type: "object",
  properties: {
    title: { type: "string" },
    description: { type: "string" },
    assignee: { type: "string", description: "login from the supplied list" },
    priority: { type: "string", enum: ["PAST", "ORTA", "YUQORI", "KRITIK"] },
    deadline: { type: "string", description: "YYYY-MM-DD or empty string" },
    rationale: { type: "string" },
  },
  required: [
    "title",
    "description",
    "assignee",
    "priority",
    "deadline",
    "rationale",
  ],
  additionalProperties: false,
} as const;

const KELISHUV_ITEM = {
  type: "object",
  properties: {
    title: { type: "string" },
    kind: { type: "string", enum: ["MOU", "LOI", "TERM_SHEET", "CONTRACT", "PROTOCOL", "OTHER"] },
    content: { type: "string", description: "the substance, in Uzbek (latin)" },
    parties: { type: "array", items: { type: "string" }, description: "company names as written" },
    amount: { type: "number", description: "0 when none" },
    currency: { type: "string", enum: ["UZS", "USD", "EUR", ""] },
    signed_on: { type: "string", description: "YYYY-MM-DD or empty" },
    valid_until: { type: "string", description: "YYYY-MM-DD or empty" },
    obligations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          owner: { type: "string", description: "login from the staff list, or empty" },
          deadline: { type: "string", description: "YYYY-MM-DD or empty" },
        },
        required: ["description", "owner", "deadline"],
        additionalProperties: false,
      },
    },
    rationale: { type: "string" },
  },
  required: ["title", "kind", "content", "parties", "amount", "currency", "signed_on", "valid_until", "obligations", "rationale"],
  additionalProperties: false,
} as const;

const COMPANY_ITEM = {
  type: "object",
  properties: {
    name: { type: "string" },
    industry: { type: "string" },
    description: { type: "string" },
    head_name: { type: "string" },
    head_position: { type: "string" },
    country: { type: "string" },
    city: { type: "string" },
    website: { type: "string" },
    rationale: { type: "string" },
  },
  required: ["name", "industry", "description", "head_name", "head_position", "country", "city", "website", "rationale"],
  additionalProperties: false,
} as const;

const STAGE_ITEM = {
  type: "object",
  properties: {
    company: { type: "string", description: "a company name from the supplied base" },
    stage: {
      type: "string",
      enum: ["NEW_CONTACT", "CONTACT", "MEETING", "PROPOSAL", "NEGOTIATION", "AGREEMENT", "ACTIVE", "MONITORING", "CLOSED"],
    },
    rationale: { type: "string" },
  },
  required: ["company", "stage", "rationale"],
  additionalProperties: false,
} as const;

const PHASE_ITEM = {
  type: "object",
  properties: {
    project: { type: "string", description: "a project code from the supplied list" },
    phase: { type: "string", enum: ["CONCEPT", "FEASIBILITY", "PREPARATION", "EXECUTION", "MONITORING", "CLOSED", "FROZEN"] },
    rationale: { type: "string" },
  },
  required: ["project", "phase", "rationale"],
  additionalProperties: false,
} as const;

const DOCUMENT_SCHEMA = {
  type: "object",
  properties: {
    documentTitle: { type: "string" },
    kind: { type: "string", enum: ["ORDER", "LETTER", "SIGNED", "REPORT", "OTHER"] },
    summary: { type: "string" },
    tasks: { type: "array", items: TASK_ITEM },
    kelishuvlar: { type: "array", items: KELISHUV_ITEM },
    companies: { type: "array", items: COMPANY_ITEM },
    stageUpdates: { type: "array", items: STAGE_ITEM },
    phaseUpdates: { type: "array", items: PHASE_ITEM },
  },
  required: ["documentTitle", "kind", "summary", "tasks", "kelishuvlar", "companies", "stageUpdates", "phaseUpdates"],
  additionalProperties: false,
} as const;

/** The base as prompt text, so drafts name what exists and nothing else. */
function baseBlock(context: IntakeContext | undefined): string {
  if (!context) return "";
  const companies = context.companies.slice(0, 300).map((c) => `- ${c.name} (${c.stage})`).join("\n");
  const projects = context.projects
    .slice(0, 150)
    .map((p) => `- ${p.code} — ${p.name}${p.phase ? ` (${p.phase})` : ""}`)
    .join("\n");
  return (
    (companies ? `\n\nBazadagi kompaniyalar (nomi va hamkorlik bosqichi):\n${companies}` : "") +
    (projects ? `\n\nLoyihalar (kodi, nomi, bosqichi):\n${projects}` : "")
  );
}

const RECORD_RULES =
  "\n\nRecords, besides tasks (TZ 7.2). `kind` says what the document is. " +
  "A signed agreement (memorandum, letter of intent, term sheet, contract, " +
  "protocol) fills `kelishuvlar` with its card: parties as written, substance, " +
  "amount and currency, dates, obligations with an owner login where the " +
  "text names one. A letter or proposal names in `companies` any company it " +
  "is from or about that the supplied base does not hold, and in " +
  "`stageUpdates` a move along the partnership path that the text itself " +
  "justifies — a proposal received is PROPOSAL, a negotiation under way is " +
  "NEGOTIATION — naming the company exactly as the base writes it. A project " +
  "report fills `phaseUpdates` with the phase the report says the project " +
  "has reached, by project code. Every one of these is a proposal a person " +
  "will confirm; propose only what the document states, and leave a list " +
  "empty rather than guess.";

const TEXT3 = {
  type: "object",
  properties: {
    uz: { type: "string" },
    ru: { type: "string" },
    en: { type: "string" },
  },
  required: ["uz", "ru", "en"],
  additionalProperties: false,
} as const;

const MEMORY_ITEM = {
  type: "object",
  properties: {
    subject: { type: "string", description: "who or what the fact is about" },
    fact: { type: "string" },
    kind: {
      type: "string",
      enum: ["qaror", "majburiyat", "xavf", "kontekst"],
    },
  },
  required: ["subject", "fact", "kind"],
  additionalProperties: false,
} as const;

const PARTNER_ITEM = {
  type: "object",
  properties: {
    name: { type: "string", description: "company or organisation name" },
    sector: { type: "string" },
    notes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["muhokama", "taklif", "ehtiyoj", "kelishuv", "xavf"],
          },
          uz: { type: "string" },
          ru: { type: "string" },
          en: { type: "string" },
        },
        required: ["kind", "uz", "ru", "en"],
        additionalProperties: false,
      },
    },
    ideas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          proposal: TEXT3,
          why: TEXT3,
          match: {
            type: "string",
            description: "other company to introduce them to, or empty",
          },
        },
        required: ["proposal", "why", "match"],
        additionalProperties: false,
      },
    },
  },
  required: ["name", "sector", "notes", "ideas"],
  additionalProperties: false,
} as const;

const MEETING_SCHEMA = {
  type: "object",
  properties: {
    summary: TEXT3,
    keyPoints: { type: "array", items: TEXT3 },
    decisions: { type: "array", items: TEXT3 },
    tasks: { type: "array", items: TASK_ITEM },
    memory: { type: "array", items: MEMORY_ITEM },
    partners: { type: "array", items: PARTNER_ITEM },
    kelishuvlar: { type: "array", items: KELISHUV_ITEM },
    companies: { type: "array", items: COMPANY_ITEM },
  },
  required: ["summary", "keyPoints", "decisions", "tasks", "memory", "partners", "kelishuvlar", "companies"],
  additionalProperties: false,
} as const;

/** The roster the model is allowed to choose from, as prompt text. */
function roster(candidates: Candidate[]): string {
  return candidates
    .map(
      (person) =>
        `- ${person.login} — ${person.full_name}, ${person.position ?? person.role}` +
        (person.department ? ` (${person.department})` : ""),
    )
    .join("\n");
}

const RULES =
  "Rules you must follow:\n" +
  "1. `assignee` MUST be one of the logins listed. Never invent a login, " +
  "never use a person's name in that field. If no listed person fits, omit " +
  "the task rather than guessing.\n" +
  "2. Only extract work the source actually asks for. Do not add tasks you " +
  "think would be sensible; an empty list is a valid answer.\n" +
  "3. `deadline` only when the source states or clearly implies a date. " +
  "Otherwise the empty string.\n" +
  "4. Write titles and descriptions in Uzbek (latin script), short and " +
  "concrete — a title is one line a person can act on.\n" +
  "5. `rationale` must point at the part of the source the task comes from.";

function parse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Builds the content block for whichever kind of file arrived. A PDF and an
 * image go to the model as-is so it reads the page itself; office formats
 * arrive already reduced to text by `extract.ts`.
 */
function sourceBlock(
  source: ExtractedSource,
  bytes: Buffer,
): Anthropic.Beta.BetaContentBlockParam {
  if (source.kind === "pdf") {
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: bytes.toString("base64"),
      },
    };
  }
  if (source.kind === "image") {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: source.mediaType as
          | "image/jpeg"
          | "image/png"
          | "image/gif"
          | "image/webp",
        data: bytes.toString("base64"),
      },
    };
  }
  return {
    type: "document",
    source: {
      type: "text",
      media_type: "text/plain",
      // Bounded: a 300-page spreadsheet would otherwise blow the run's budget
      // on rows that repeat the same instruction.
      data: source.text.slice(0, 120_000),
    },
  };
}

/**
 * Reads an incoming document and proposes who should do what. Accepts PDF,
 * photos and scans, and Word/Excel/PowerPoint/plain text.
 */
export async function analyzeDocument(
  bytes: Buffer,
  source: ExtractedSource,
  fileName: string,
  candidates: Candidate[],
  budgetTokens: number,
  context?: IntakeContext,
): Promise<DocumentAnalysis | null> {
  if (!isConfigured() || candidates.length === 0) return null;
  const client = new Anthropic();

  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: Math.min(8000, Math.floor(budgetTokens / 3)),
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: {
        // Extraction, not deep reasoning: `medium` reads a document as well as
        // `high` here and costs materially less per run.
        effort: "medium",
        format: { type: "json_schema", schema: DOCUMENT_SCHEMA },
      },
      system:
        "You process incoming documents for the Uzbekistan Economy Assembly " +
        "and turn them into assignments for named staff, and into the records " +
        "the document carries.\n\n" +
        RULES +
        RECORD_RULES,
      messages: [
        {
          role: "user",
          content: [
            sourceBlock(source, bytes),
            {
              type: "text",
              text:
                `Hujjat: ${fileName} (${source.label})\n\nMas'ul etib tayinlash mumkin bo'lgan xodimlar:\n${roster(candidates)}` +
                baseBlock(context) +
                "\n\nHujjatni o'qing, undagi topshiriqlarni ajratib oling va har birini " +
                "ro'yxatdagi eng mos xodimga taqsimlang. Hujjat turini aniqlang va " +
                "undagi yozuvlarni (kelishuv, kompaniya, bosqich, loyiha fazasi) qoralama sifatida bering.",
            },
          ],
        },
      ],
    });

    if (response.stop_reason === "refusal") return null;
    const block = response.content.find((item) => item.type === "text");
    if (!block || block.type !== "text") return null;

    const parsed = parse<Omit<DocumentAnalysis, "model" | "tokensIn" | "tokensOut">>(
      block.text,
    );
    if (!parsed) return null;

    return {
      ...parsed,
      kind: DOCUMENT_KINDS.includes(parsed.kind) ? parsed.kind : "OTHER",
      tasks: parsed.tasks ?? [],
      kelishuvlar: parsed.kelishuvlar ?? [],
      companies: parsed.companies ?? [],
      stageUpdates: parsed.stageUpdates ?? [],
      phaseUpdates: parsed.phaseUpdates ?? [],
      model: response.model,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
    };
  } catch {
    return null;
  }
}

/** Turns a meeting transcript into key points, decisions and draft tasks. */
export async function analyzeMeeting(
  transcript: string,
  title: string,
  candidates: Candidate[],
  budgetTokens: number,
  lang = "uz-UZ",
  facts: MemoryFact[] = [],
  context?: IntakeContext,
): Promise<MeetingAnalysis | null> {
  if (!isConfigured() || !transcript.trim()) return null;
  const client = new Anthropic();

  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: Math.min(8000, Math.floor(budgetTokens / 3)),
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: {
        // Extraction, not deep reasoning: `medium` reads a document as well as
        // `high` here and costs materially less per run.
        effort: "medium",
        format: { type: "json_schema", schema: MEETING_SCHEMA },
      },
      system:
        "You process meeting recordings for the Uzbekistan Economy Assembly. " +
        "The transcript comes from speech recognition, so it contains errors — " +
        "read through them, and never quote a garbled passage as a decision. " +
        // Knowing the recognition language matters: the same garbled run of
        // characters is a different likely word in Uzbek than in Russian, and
        // a meeting may switch language mid-way.
        `The speech was recognised as ${lang}; it may also contain Uzbek, ` +
        "Russian and English passages regardless of that setting.\n\n" +
        "`keyPoints` are the 3-7 things a chairman who missed the meeting must " +
        "know. `decisions` are only what was actually agreed, not what was " +
        "discussed.\n\n" +
        "`summary`, `keyPoints` and `decisions` are each written three times: " +
        "`uz` in Uzbek (latin script), `ru` in Russian, `en` in English. Write " +
        "each one as a native reader of that language would — say the same " +
        "thing, do not transliterate the Uzbek. Keep names, logins, figures " +
        "and dates identical across all three.\n\n" +
        // The platform has no memory of its own; this is where it gets one.
        "`memory` is what should still be known a month from now, once the " +
        "transcript is nobody's idea of light reading: commitments people " +
        "made, decisions that still bind, risks that were raised. Write each " +
        "so it stands on its own — a reader a month from now has no idea what " +
        "'the second option' referred to. Skip anything already captured as a " +
        "task; the task is its own record. An empty list is a valid answer.\n\n" +
        // The reason meetings are recorded at all: a chairman with four a week
        // cannot hold the state of thirty relationships in his head.
        "`partners` is the companies and organisations this meeting was about. " +
        "For each, record what was discussed (`muhokama`), what we offered " +
        "(`taklif`), what they said they need (`ehtiyoj`), what was agreed " +
        "(`kelishuv`) and any risk (`xavf`).\n\n" +
        "`ideas` is the part that earns its keep: what to propose that company " +
        "next. Draw on the negotiation history supplied below, not only on " +
        "this meeting — if an earlier company needed something this one offers, " +
        "say so and put that company's name in `match`. Propose only what the " +
        "history actually supports; an invented opportunity costs a real " +
        "meeting. Leave `match` empty when the idea involves no second company, " +
        "and return an empty list when nothing is worth proposing.\n\n" +
        "`kelishuvlar` holds an agreement's card only when the meeting " +
        "actually reached one — parties, substance, amount, dates, " +
        "obligations; `companies` the organisations met that the supplied " +
        "base does not hold. Both are drafts a person confirms (TZ 7.2).\n\n" +
        RULES,
      messages: [
        {
          role: "user",
          content:
            `Uchrashuv: ${title}\n\nXodimlar:\n${roster(candidates)}` +
            baseBlock(context) +
            memoryBlock(facts) +
            (await partnerHistory()) +
            `\n\nBayonnoma (avtomatik tanilgan matn):\n"""\n${transcript.slice(0, 60_000)}\n"""`,
        },
      ],
    });

    if (response.stop_reason === "refusal") return null;
    const block = response.content.find((item) => item.type === "text");
    if (!block || block.type !== "text") return null;

    const parsed = parse<Omit<MeetingAnalysis, "model" | "tokensIn" | "tokensOut">>(
      block.text,
    );
    if (!parsed) return null;

    return {
      summary: parsed.summary ?? { uz: "", ru: "", en: "" },
      keyPoints: parsed.keyPoints ?? [],
      decisions: parsed.decisions ?? [],
      tasks: parsed.tasks ?? [],
      memory: parsed.memory ?? [],
      partners: parsed.partners ?? [],
      kelishuvlar: parsed.kelishuvlar ?? [],
      companies: parsed.companies ?? [],
      model: response.model,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
    };
  } catch {
    return null;
  }
}
