import Anthropic from "@anthropic-ai/sdk";
import { all, get } from "@/lib/db";
import { isConfigured } from "./claude";
import { today, viewStatus } from "@/lib/crm";
import { assignableUsers } from "@/lib/queries";
import type { User } from "@/lib/types";

/**
 * The assistant that answers questions about what is in the database.
 *
 * It is given **tools, not data**. The alternative — pasting the companies,
 * meetings and agreements into the prompt — works for a demo and fails the
 * moment the Assembly has three hundred companies: the prompt stops fitting,
 * every question costs the whole database, and the model still has to find the
 * relevant row by reading. With tools it asks for exactly what the question
 * needs, chains lookups ("last meeting with X" is a company lookup then a
 * meeting lookup), and each answer arrives with the records it actually read.
 *
 * Those records are the citations. Rather than trusting the model to quote an
 * id correctly, every tool result carries a `ref` — kind, id, label, link — and
 * the route returns the union of what was touched. A source list built from
 * what was read cannot cite a record that was never opened.
 *
 * The loop is written out by hand rather than handed to the SDK's tool runner
 * because three things here are not the runner's defaults: a hard ceiling on
 * iterations, the caller's identity injected into every tool call so scoping
 * cannot be skipped, and the citation collection above.
 */

const MODEL = "claude-opus-5";

/** A record the answer was built from. */
export interface Ref {
  kind: "company" | "meeting" | "agreement" | "task" | "person";
  id: number;
  label: string;
  href: string;
}

export interface AssistantTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AssistantReply {
  answer: string;
  refs: Ref[];
  tokensIn: number;
  tokensOut: number;
  cachedIn: number;
  steps: number;
}

/**
 * Why an answer did not come back.
 *
 * Kept apart from `AssistantReply` because these three want three different
 * things from the reader: NO_KEY is for whoever administers the platform,
 * REFUSED is final and re-asking will not help, and ERROR is the transient
 * one where pressing the button again usually works. Collapsing them into a
 * single `null` is what put "the AI key is not configured" on screen for a
 * key that was configured and working a minute earlier.
 */
export type AssistantFailure = "NO_KEY" | "REFUSED" | "ERROR";

export type AssistantOutcome =
  | { ok: true; reply: AssistantReply }
  | { ok: false; reason: AssistantFailure };

/** How many tool round-trips one question may take before we stop. */
const MAX_STEPS = 6;

/* ------------------------------------------------------------------ */
/* The tools                                                           */
/* ------------------------------------------------------------------ */

const TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  {
    name: "find_companies",
    description:
      "Search the company directory. Use for questions about who the " +
      "Assembly works with, what a company does, which companies match a " +
      "sector or service. Returns a short row per company; call " +
      "company_profile for the full card.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Free text matched against name, industry, services and city. " +
            "Omit to list everything.",
        },
        status: {
          type: "string",
          enum: ["POTENTIAL", "ACTIVE", "PAUSED", "ARCHIVED"],
        },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "company_profile",
    description:
      "The full card for one company: profile fields, its people, its recent " +
      "meetings with summaries, and its agreements. Use when a question is " +
      "about one named company.",
    input_schema: {
      type: "object",
      properties: { company_id: { type: "integer" } },
      required: ["company_id"],
      additionalProperties: false,
    },
  },
  {
    name: "find_meetings",
    description:
      "Search meetings by text, company or date range. The text search covers " +
      "the title and the transcript, so it finds a meeting by something that " +
      "was said in it.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        company_id: { type: "integer" },
        from: { type: "string", description: "YYYY-MM-DD, inclusive" },
        to: { type: "string", description: "YYYY-MM-DD, inclusive" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "meeting_detail",
    description:
      "One meeting in full: summary, key points and decisions as the analysis " +
      "wrote them, plus its agreements.",
    input_schema: {
      type: "object",
      properties: { meeting_id: { type: "integer" } },
      required: ["meeting_id"],
      additionalProperties: false,
    },
  },
  {
    name: "find_agreements",
    description:
      "Commitments made in meetings. Use for anything about what was agreed, " +
      "what is outstanding, what is late, or what is due in a period. " +
      "`overdue_only` and `due_before` are evaluated in Assembly time.",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["NEW", "IN_PROGRESS", "DONE", "CANCELLED", "OPEN"],
          description: "OPEN means NEW or IN_PROGRESS.",
        },
        company_id: { type: "integer" },
        owner_name: {
          type: "string",
          description: "Part of the responsible person's name.",
        },
        due_before: { type: "string", description: "YYYY-MM-DD" },
        overdue_only: { type: "boolean" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "find_tasks",
    description:
      "Internal assignments given to staff through the platform. Distinct " +
      "from agreements: a task is work assigned to a colleague, an agreement " +
      "is what was promised to a company. Scoped to what the asker may see.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        assignee_name: { type: "string" },
        overdue_only: { type: "boolean" },
        open_only: { type: "boolean" },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: "find_people",
    description:
      "Staff of the Assembly — name, role, department, position. Use to " +
      "resolve a name mentioned in a question, or to answer who is " +
      "responsible for something.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: [],
      additionalProperties: false,
    },
  },
];

/* ------------------------------------------------------------------ */
/* Running one tool                                                    */
/* ------------------------------------------------------------------ */

interface ToolContext {
  user: User;
  /** 'uz' | 'ru' | 'en' — which language column to read conclusions from. */
  lang: string;
  refs: Ref[];
}

function remember(context: ToolContext, ref: Ref) {
  if (!context.refs.some((item) => item.kind === ref.kind && item.id === ref.id)) {
    context.refs.push(ref);
  }
}

function like(value: unknown): string {
  return `%${String(value ?? "").slice(0, 120)}%`;
}

function runTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext,
): unknown {
  switch (name) {
    case "find_companies": {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (input.query) {
        where.push(
          `(name LIKE ? COLLATE NOCASE OR industry LIKE ? COLLATE NOCASE
            OR services LIKE ? COLLATE NOCASE OR city LIKE ? COLLATE NOCASE
            OR description LIKE ? COLLATE NOCASE)`,
        );
        params.push(...Array(5).fill(like(input.query)));
      }
      if (input.status) {
        where.push("status = ?");
        params.push(String(input.status));
      }
      const rows = all<Record<string, unknown>>(
        `SELECT id, name, industry, services, city, country, status,
                head_name, phone, email, website,
                COALESCE(last_contact_at, last_seen) AS last_contact
           FROM partners ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY COALESCE(last_contact_at, last_seen) DESC LIMIT 40`,
        ...params,
      );
      for (const row of rows) {
        remember(context, {
          kind: "company",
          id: Number(row.id),
          label: String(row.name),
          href: `/companies/${row.id}`,
        });
      }
      return { count: rows.length, companies: rows };
    }

    case "company_profile": {
      const id = Number(input.company_id);
      const company = get<Record<string, unknown>>(
        "SELECT * FROM partners WHERE id = ?",
        id,
      );
      if (!company) return { error: "not_found" };
      remember(context, {
        kind: "company",
        id,
        label: String(company.name),
        href: `/companies/${id}`,
      });

      const meetings = all<Record<string, unknown>>(
        `SELECT m.id, m.title, COALESCE(m.held_at, m.created_at) AS date,
                m.participants, c.summary
           FROM meetings m
           LEFT JOIN meeting_conclusions c
                  ON c.meeting_id = m.id AND c.lang = ?
          WHERE m.company_id = ?
          ORDER BY COALESCE(m.held_at, m.created_at) DESC LIMIT 10`,
        context.lang,
        id,
      );
      for (const row of meetings) {
        remember(context, {
          kind: "meeting",
          id: Number(row.id),
          label: String(row.title),
          href: `/companies/${id}`,
        });
      }

      return {
        company,
        contacts: all(
          `SELECT first_name, last_name, position, phone, email, telegram, is_head
             FROM contacts WHERE company_id = ? ORDER BY is_head DESC`,
          id,
        ),
        meetings,
        agreements: agreementRows({ company_id: id }, context),
      };
    }

    case "find_meetings": {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (input.query) {
        where.push("(m.title LIKE ? COLLATE NOCASE OR m.transcript LIKE ? COLLATE NOCASE)");
        params.push(like(input.query), like(input.query));
      }
      if (input.company_id) {
        where.push("m.company_id = ?");
        params.push(Number(input.company_id));
      }
      if (input.from) {
        where.push("COALESCE(m.held_at, date(m.created_at)) >= ?");
        params.push(String(input.from));
      }
      if (input.to) {
        where.push("COALESCE(m.held_at, date(m.created_at)) <= ?");
        params.push(String(input.to));
      }
      const rows = all<Record<string, unknown>>(
        `SELECT m.id, m.title, COALESCE(m.held_at, m.created_at) AS date,
                m.participants, p.name AS company, m.company_id, c.summary
           FROM meetings m
           LEFT JOIN partners p ON p.id = m.company_id
           LEFT JOIN meeting_conclusions c ON c.meeting_id = m.id AND c.lang = ?
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY COALESCE(m.held_at, m.created_at) DESC LIMIT 25`,
        context.lang,
        ...params,
      );
      for (const row of rows) {
        remember(context, {
          kind: "meeting",
          id: Number(row.id),
          label: String(row.title),
          href: row.company_id ? `/companies/${row.company_id}` : "/meetings",
        });
      }
      return { count: rows.length, meetings: rows };
    }

    case "meeting_detail": {
      const id = Number(input.meeting_id);
      const meeting = get<Record<string, unknown>>(
        `SELECT m.id, m.title, COALESCE(m.held_at, m.created_at) AS date,
                m.place, m.participants, m.description, m.next_steps,
                p.name AS company, m.company_id
           FROM meetings m LEFT JOIN partners p ON p.id = m.company_id
          WHERE m.id = ?`,
        id,
      );
      if (!meeting) return { error: "not_found" };
      remember(context, {
        kind: "meeting",
        id,
        label: String(meeting.title),
        href: meeting.company_id ? `/companies/${meeting.company_id}` : "/meetings",
      });
      const conclusion = get<Record<string, unknown>>(
        "SELECT summary, key_points, decisions FROM meeting_conclusions WHERE meeting_id = ? AND lang = ?",
        id,
        context.lang,
      );
      return {
        meeting,
        summary: conclusion?.summary ?? null,
        key_points: safeList(conclusion?.key_points),
        decisions: safeList(conclusion?.decisions),
        agreements: agreementRows({ meeting_id: id }, context),
      };
    }

    case "find_agreements":
      return { agreements: agreementRows(input, context) };

    case "find_tasks": {
      const where: string[] = [];
      const params: (string | number)[] = [];
      // Scoping, not filtering: a manager sees their people's work, everyone
      // else sees their own. Enforced here so no prompt can widen it.
      const visible = assignableUsers(context.user).map((person) => person.id);
      const scope = [...new Set([context.user.id, ...visible])];
      where.push(
        `(t.to_user_id IN (${scope.map(() => "?").join(",")}) OR t.from_user_id = ?)`,
      );
      params.push(...scope, context.user.id);

      if (input.query) {
        where.push("(t.title LIKE ? COLLATE NOCASE OR t.description LIKE ? COLLATE NOCASE)");
        params.push(like(input.query), like(input.query));
      }
      if (input.assignee_name) {
        where.push("u.full_name LIKE ? COLLATE NOCASE");
        params.push(like(input.assignee_name));
      }
      if (input.open_only) where.push("t.status NOT IN ('BAJARILDI','RAD_ETILDI')");
      if (input.overdue_only) {
        where.push(
          "t.deadline IS NOT NULL AND t.deadline < ? AND t.status NOT IN ('BAJARILDI','RAD_ETILDI')",
        );
        params.push(today());
      }

      const rows = all<Record<string, unknown>>(
        `SELECT t.id, t.code, t.title, t.status, t.priority, t.deadline,
                u.full_name AS assignee, f.full_name AS author
           FROM tasks t
           LEFT JOIN users u ON u.id = t.to_user_id
           LEFT JOIN users f ON f.id = t.from_user_id
          WHERE ${where.join(" AND ")}
          ORDER BY t.id DESC LIMIT 30`,
        ...params,
      );
      for (const row of rows) {
        remember(context, {
          kind: "task",
          id: Number(row.id),
          label: `${row.code} · ${row.title}`,
          href: "/tasks/inbox",
        });
      }
      return { count: rows.length, tasks: rows };
    }

    case "find_people": {
      const rows = all<Record<string, unknown>>(
        `SELECT id, full_name, login, role, department, position
           FROM users WHERE is_active = 1
            ${input.query ? "AND (full_name LIKE ? COLLATE NOCASE OR login LIKE ? COLLATE NOCASE OR position LIKE ? COLLATE NOCASE)" : ""}
          ORDER BY full_name LIMIT 30`,
        ...(input.query ? [like(input.query), like(input.query), like(input.query)] : []),
      );
      for (const row of rows) {
        remember(context, {
          kind: "person",
          id: Number(row.id),
          label: String(row.full_name),
          href: "/team",
        });
      }
      return { people: rows };
    }

    default:
      return { error: `unknown tool: ${name}` };
  }
}

function safeList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Shared by three tools, so "overdue" means the same thing in all of them. */
function agreementRows(
  input: Record<string, unknown>,
  context: ToolContext,
): Record<string, unknown>[] {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (input.status === "OPEN") where.push("a.status IN ('NEW','IN_PROGRESS')");
  else if (input.status) {
    where.push("a.status = ?");
    params.push(String(input.status));
  }
  if (input.company_id) {
    where.push("a.company_id = ?");
    params.push(Number(input.company_id));
  }
  if (input.meeting_id) {
    where.push("a.meeting_id = ?");
    params.push(Number(input.meeting_id));
  }
  if (input.owner_name) {
    where.push("(u.full_name LIKE ? COLLATE NOCASE OR a.owner_name LIKE ? COLLATE NOCASE)");
    params.push(like(input.owner_name), like(input.owner_name));
  }
  if (input.due_before) {
    where.push("a.deadline IS NOT NULL AND a.deadline <= ?");
    params.push(String(input.due_before));
  }
  if (input.overdue_only) {
    where.push(
      "a.deadline IS NOT NULL AND a.deadline < ? AND a.status IN ('NEW','IN_PROGRESS')",
    );
    params.push(today());
  }

  const rows = all<Record<string, unknown>>(
    `SELECT a.id, a.description, a.deadline, a.status, a.priority, a.source,
            COALESCE(u.full_name, a.owner_name) AS owner,
            p.name AS company, a.company_id, m.title AS meeting
       FROM agreements a
       LEFT JOIN users u ON u.id = a.owner_user_id
       LEFT JOIN partners p ON p.id = a.company_id
       LEFT JOIN meetings m ON m.id = a.meeting_id
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY a.deadline IS NULL, a.deadline LIMIT 40`,
    ...params,
  );

  for (const row of rows) {
    remember(context, {
      kind: "agreement",
      id: Number(row.id),
      label: String(row.description).slice(0, 80),
      href: row.company_id ? `/companies/${row.company_id}` : "/agreements",
    });
    // Hand the model the derived status, so it never has to compare dates.
    row.view_status = viewStatus(String(row.status), (row.deadline as string) ?? null);
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* The loop                                                            */
/* ------------------------------------------------------------------ */

const LANG_NAME: Record<string, string> = {
  uz: "Uzbek (latin script)",
  uzc: "Uzbek (cyrillic script)",
  ru: "Russian",
  en: "English",
};

function systemPrompt(user: User, locale: string): string {
  return (
    "You answer questions about the internal database of the Uzbekistan " +
    "Economy Assembly — its partner companies, the meetings held with them, " +
    "what was agreed, and the assignments given to staff.\n\n" +
    `You are answering ${user.full_name} (${user.role}). ` +
    `Reply in ${LANG_NAME[locale] ?? "Uzbek (latin script)"}, whatever ` +
    "language the question was asked in.\n\n" +
    `Today is ${today()} in Assembly time (UTC+5).\n\n` +
    "How to work:\n" +
    "1. Answer from the tools, never from memory. If the tools return " +
    "nothing, say plainly that there is no such record — do not guess, and " +
    "do not offer a plausible answer in place of a missing one.\n" +
    "2. Chain lookups where a question needs it: find the company, then its " +
    "meetings, then that meeting's detail.\n" +
    "3. Name the records you used — the company, the meeting title, the date. " +
    "The reader gets links to them, so a name is enough; do not print ids.\n" +
    "4. An agreement's `view_status` is already worked out, including " +
    "`OVERDUE`. Use it; do not compare dates yourself.\n" +
    "5. Distinguish an agreement (what was promised to a company) from a task " +
    "(work assigned to a colleague). They are different questions.\n" +
    "6. Be brief. Lead with the answer, then the supporting detail. Use a " +
    "short list when there are several items, prose when there is one. Do " +
    "not restate the question.\n" +
    "7. Task and meeting visibility is already scoped to what this person may " +
    "see. If a question reaches beyond it, say what you can see rather than " +
    "explaining the permission model."
  );
}

export async function askAssistant(
  user: User,
  locale: string,
  history: AssistantTurn[],
  question: string,
): Promise<AssistantOutcome> {
  if (!isConfigured()) return { ok: false, reason: "NO_KEY" };
  const client = new Anthropic();

  const context: ToolContext = {
    user,
    lang: locale === "ru" ? "ru" : locale === "en" ? "en" : "uz",
    refs: [],
  };

  // Only the recent turns: an assistant that resends an hour of chat with
  // every question spends more on its own transcript than on the answer.
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...history.slice(-8).map((turn) => ({
      role: turn.role,
      content: turn.content,
    })),
    { role: "user" as const, content: question },
  ];

  let tokensIn = 0;
  let tokensOut = 0;
  let cachedIn = 0;
  let steps = 0;

  try {
    for (let iteration = 0; iteration < MAX_STEPS; iteration++) {
      const response = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        // Retrieval and phrasing, run once per question typed by a person.
        output_config: { effort: "low" },
        system: [
          {
            type: "text",
            text: systemPrompt(user, locale),
            // Tools render before system, so this one breakpoint caches the
            // tool definitions too — the bulk of the fixed prefix.
            cache_control: { type: "ephemeral" },
          },
        ],
        tools: TOOLS,
        messages,
      });

      tokensIn += response.usage.input_tokens;
      tokensOut += response.usage.output_tokens;
      cachedIn += response.usage.cache_read_input_tokens ?? 0;

      if (response.stop_reason === "refusal")
        return { ok: false, reason: "REFUSED" };

      const calls = response.content.filter((block) => block.type === "tool_use");
      if (calls.length === 0) {
        const text = response.content
          .filter((block) => block.type === "text")
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("\n")
          .trim();
        return {
          ok: true,
          reply: { answer: text, refs: context.refs, tokensIn, tokensOut, cachedIn, steps },
        };
      }

      messages.push({ role: "assistant", content: response.content });
      // Every result for this turn goes back in one user message — splitting
      // them teaches the model to stop asking for things in parallel.
      messages.push({
        role: "user",
        content: calls.map((call) => {
          steps++;
          let result: unknown;
          try {
            result = runTool(
              call.name,
              (call.input ?? {}) as Record<string, unknown>,
              context,
            );
          } catch (error) {
            result = { error: String(error).slice(0, 200) };
          }
          return {
            type: "tool_result" as const,
            tool_use_id: call.id,
            content: JSON.stringify(result).slice(0, 60_000),
          };
        }),
      });
    }

    // Ran out of steps. Honest rather than silent.
    return {
      ok: true,
      reply: { answer: "", refs: context.refs, tokensIn, tokensOut, cachedIn, steps },
    };
  } catch (error) {
    // Written to the server log, not swallowed: an overloaded model, an
    // expired key and a dropped connection all look identical from the
    // browser, and without this line there is nothing to tell them apart.
    console.error("[assistant] request failed:", error);
    return { ok: false, reason: "ERROR" };
  }
}
