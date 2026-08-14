import Anthropic from "@anthropic-ai/sdk";
import type { Finding } from "./analyzers";
import type { AgentSpec } from "./registry";

/**
 * The model layer, kept deliberately small.
 *
 * `analyzers.ts` decides *what is true* — it reads rows and produces findings
 * with citations. Claude is asked only to turn those findings into a short
 * briefing a busy reader can act on. It is given no tools, no database, and no
 * ability to add, drop or renumber a finding, so a hallucination can change the
 * wording of a summary but never the facts underneath it or the actions queued
 * for approval.
 *
 * When no credentials are configured the platform runs unchanged: every agent
 * still gathers context, produces findings and queues proposals — it just does
 * not get the narrative paragraph.
 */

const MODEL = "claude-opus-5";

export interface Summary {
  text: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
}

/** True when an API key or CLI profile is present for the SDK to pick up. */
export function isConfigured(): boolean {
  return Boolean(
    process.env.ANTHROPIC_API_KEY?.trim() ||
      process.env.ANTHROPIC_AUTH_TOKEN?.trim(),
  );
}

const SCHEMA = {
  type: "object",
  properties: {
    summary: {
      type: "string",
      description:
        "2-4 sentence briefing in Uzbek (latin script), based only on the findings given.",
    },
  },
  required: ["summary"],
  additionalProperties: false,
} as const;

/**
 * Rewrites findings as a briefing. Returns null on any failure — a missing
 * summary is a cosmetic loss, so nothing about an agent run depends on the
 * model being reachable, in credit, or willing to answer.
 */
export async function summarize(
  agent: AgentSpec,
  findings: Finding[],
  budgetTokens: number,
): Promise<Summary | null> {
  if (!isConfigured() || findings.length === 0) return null;

  const client = new Anthropic();

  const facts = findings
    .map(
      (finding, index) =>
        `${index + 1}. [${finding.severity}] ${finding.title} — ${finding.body} (manba: ${finding.evidence})`,
    )
    .join("\n");

  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      // Budget-derived, and well under it: this is a summarisation call, and
      // the ceiling in the registry covers the whole run.
      max_tokens: Math.min(2000, Math.floor(budgetTokens / 8)),
      betas: ["server-side-fallback-2026-07-01"],
      // Opus 5 can decline a request outright; the default fallback routes the
      // retry to a model Anthropic recommends for that refusal category rather
      // than pinning one here.
      fallbacks: "default",
      thinking: { type: "adaptive" },
      // Low effort is right for the work: the analysis already happened, this
      // is a rewrite.
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: SCHEMA },
      },
      system:
        "You brief the leadership of the Uzbekistan Economy Assembly. " +
        "Write in Uzbek (latin script), 2-4 sentences, plain and specific. " +
        "Use ONLY the findings supplied: never add a number, a name, or a " +
        "conclusion that is not in them, and never soften or drop a severity. " +
        "Lead with what needs a decision.",
      messages: [
        {
          role: "user",
          content: `Agent: ${agent.title}\nVazifa: ${agent.task}\n\nAniqlangan holatlar:\n${facts}`,
        },
      ],
    });

    // Opus 5 returns a normal 200 on a policy decline — check before reading.
    if (response.stop_reason === "refusal") return null;

    const block = response.content.find((item) => item.type === "text");
    if (!block || block.type !== "text") return null;

    let text = block.text.trim();
    try {
      const parsed = JSON.parse(text) as { summary?: string };
      if (parsed.summary) text = parsed.summary.trim();
    } catch {
      /* structured output should be JSON; fall back to the raw text */
    }
    if (!text) return null;

    return {
      text,
      model: response.model,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
    };
  } catch {
    // Unreachable, unauthenticated, rate-limited, over budget — all the same
    // to the caller: the run proceeds without a narrative.
    return null;
  }
}
