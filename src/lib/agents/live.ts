import Anthropic from "@anthropic-ai/sdk";
import { all, now, run } from "@/lib/pg";
import { isConfigured } from "./claude";
import type { Candidate } from "./intake";

/**
 * The meeting agent while the meeting is still happening.
 *
 * The end-of-meeting analysis reads a finished transcript once. This reads it
 * as it arrives: every round the recorder uploads the audio so far, Whisper
 * transcribes only the new minute, and the model is handed *the running
 * picture plus that minute* — not the whole meeting again. It returns the
 * picture updated: what matters so far, what has actually been agreed, who is
 * on the hook for what, and what is still open.
 *
 * That shape is what makes this affordable. Cost per round is one small state
 * object and one minute of speech, against a system prompt and staff roster
 * that never change and are therefore served from the prompt cache at a tenth
 * of the price. A two-hour meeting costs about what a single end-of-meeting
 * analysis used to.
 *
 * The model is not trained on any of this and cannot be — the Claude API has
 * no fine-tuning. What makes it accurate here is what it is *given*: the real
 * staff list, the Assembly's own vocabulary, and the facts earlier meetings
 * left behind (see `recallMemory`). That is retrieval, and unlike training it
 * takes effect the moment a fact is written down.
 */

const MODEL = "claude-opus-5";

export interface PlanItem {
  title: string;
  /** Login of the person on the hook, or "" when nobody was named. */
  owner: string;
  /** `YYYY-MM-DD`, or "" when no date was given. */
  due: string;
  /** How firm it is: proposed, agreed, or already under way. */
  status: "taklif" | "kelishildi" | "bajarilmoqda";
}

export interface LiveState {
  keyPoints: string[];
  decisions: string[];
  plan: PlanItem[];
  questions: string[];
}

export interface LiveUpdate extends LiveState {
  tokensIn: number;
  tokensOut: number;
  cachedIn: number;
}

export const EMPTY_STATE: LiveState = {
  keyPoints: [],
  decisions: [],
  plan: [],
  questions: [],
};

const LIVE_SCHEMA = {
  type: "object",
  properties: {
    keyPoints: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    plan: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          owner: { type: "string", description: "login from the list, or empty" },
          due: { type: "string", description: "YYYY-MM-DD or empty string" },
          status: {
            type: "string",
            enum: ["taklif", "kelishildi", "bajarilmoqda"],
          },
        },
        required: ["title", "owner", "due", "status"],
        additionalProperties: false,
      },
    },
    questions: { type: "array", items: { type: "string" } },
  },
  required: ["keyPoints", "decisions", "plan", "questions"],
  additionalProperties: false,
} as const;

/**
 * Deliberately long, and deliberately frozen. It sits before the cache
 * breakpoint, so every round after the first reads it at a tenth of the input
 * price — which is why the rules can be spelled out properly instead of
 * compressed into hints the model has to guess at.
 */
const SYSTEM =
  "You follow a live meeting of the Uzbekistan Economy Assembly and keep a " +
  "running picture of it for the people in the room.\n\n" +
  "Each turn you receive the picture as it stands and the newest stretch of " +
  "speech. Return the picture updated — the complete state, not a diff.\n\n" +
  "How to judge what you hear:\n" +
  "- `keyPoints`: the 3-7 things a chairman who missed the meeting must know. " +
  "Replace a weaker point rather than letting the list grow past seven.\n" +
  "- `decisions`: only what was actually settled. Someone saying an idea is " +
  "good is not a decision; someone saying it will be done is.\n" +
  "- `plan`: work somebody is now expected to do. `status` is `taklif` when " +
  "it was merely proposed, `kelishildi` once the room agreed, and " +
  "`bajarilmoqda` when it is already under way. Promote an item's status when " +
  "later speech settles it — that is the point of re-reading the state.\n" +
  "- `questions`: what was raised and left unanswered. Remove a question the " +
  "moment the meeting answers it.\n\n" +
  "Rules:\n" +
  "1. `owner` MUST be a login from the list below, or the empty string. Never " +
  "invent a login and never put a person's name in that field.\n" +
  "2. The text is speech recognition and contains errors. Read through them; " +
  "never quote a garbled passage as a decision. Names are what it gets wrong " +
  "most — match a mangled name to the roster rather than repeating it.\n" +
  "3. Correct yourself freely. If the new speech contradicts something you " +
  "recorded, the new speech wins — a meeting changes its mind, and the state " +
  "must end up describing where it landed, not every place it passed through.\n" +
  "4. An empty list is a valid answer. Do not invent structure for a meeting " +
  "that is still small talk.\n" +
  "5. Write in Uzbek (latin script), short and concrete.";

function roster(candidates: Candidate[]): string {
  return candidates
    .map(
      (person) =>
        `- ${person.login} — ${person.full_name}, ${person.position ?? person.role}` +
        (person.department ? ` (${person.department})` : ""),
    )
    .join("\n");
}

/**
 * Everyone who might be named in a meeting — including the person recording it.
 *
 * Deliberately wider than `assignableUsers`. That list answers "whom may this
 * person hand work to", which is the right question when a task is about to be
 * created and the wrong one here: the live picture reports what was said, and
 * a department head who commits to something in her own meeting belongs in it.
 * Nothing on this screen creates anything — the strict check still stands
 * where it matters, at the end, and again when the task is written.
 */
export async function roomRoster(): Promise<Candidate[]> {
  return await all<Candidate>(
    `SELECT login, full_name, role, department, position
       FROM users WHERE is_active = 1 ORDER BY role, full_name`,
  );
}

/* ------------------------------------------------------------------ */
/* Memory — what the platform carries between meetings                 */
/* ------------------------------------------------------------------ */

export interface MemoryFact {
  subject: string;
  fact: string;
  kind: string;
}

/**
 * The facts worth putting in front of the model. Recency-ordered and bounded:
 * a long list would cost more than it is worth and would bury the ones that
 * still matter under the ones that no longer do.
 */
export async function recallMemory(limit = 20): Promise<MemoryFact[]> {
  return await all<MemoryFact>(
    "SELECT subject, fact, kind FROM meeting_memory ORDER BY id DESC LIMIT ?",
    limit,
  );
}

export function memoryBlock(facts: MemoryFact[]): string {
  if (facts.length === 0) return "";
  return (
    "\n\nOldingi uchrashuvlardan esda qolgani:\n" +
    facts.map((item) => `- [${item.kind}] ${item.subject}: ${item.fact}`).join("\n")
  );
}

/** Writes what this meeting should be remembered for. */
export async function rememberFacts(
  meetingId: number | null,
  facts: MemoryFact[],
): Promise<number> {
  let written = 0;
  for (const item of facts.slice(0, 12)) {
    const subject = item.subject?.trim().slice(0, 120);
    const fact = item.fact?.trim().slice(0, 400);
    if (!subject || !fact) continue;
    await run(
      `INSERT INTO meeting_memory (meeting_id, subject, fact, kind, created_at)
       VALUES (?,?,?,?,?)`,
      meetingId,
      subject,
      fact,
      item.kind?.trim().slice(0, 20) || "kontekst",
      now(),
    );
    written++;
  }
  return written;
}

/* ------------------------------------------------------------------ */

function parse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * One round: the picture so far plus the newest speech, in; the picture
 * updated, out.
 */
export async function updateLiveState(
  previous: LiveState,
  segment: string,
  candidates: Candidate[],
  lang: string,
  facts: MemoryFact[],
  title: string,
): Promise<LiveUpdate | null> {
  if (!isConfigured() || !segment.trim()) return null;
  const client = new Anthropic();

  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: {
        // Merging a minute of speech into a small state object is not deep
        // reasoning, and this runs once a minute for the length of a meeting.
        effort: "low",
        format: { type: "json_schema", schema: LIVE_SCHEMA },
      },
      system: [
        { type: "text", text: SYSTEM },
        {
          // Everything above this line is identical on every round of every
          // meeting, so from the second round on it is served from cache.
          type: "text",
          text: `Mas'ul etib ko'rsatish mumkin bo'lgan xodimlar:\n${roster(candidates)}`,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content:
            `Uchrashuv: ${title}\nNutq tili: ${lang}` +
            memoryBlock(facts) +
            `\n\nHozirgi holat (JSON):\n${JSON.stringify(previous)}` +
            `\n\nYangi nutq:\n"""\n${segment.slice(0, 12_000)}\n"""`,
        },
      ],
    });

    if (response.stop_reason === "refusal") return null;
    const block = response.content.find((item) => item.type === "text");
    if (!block || block.type !== "text") return null;

    const parsed = parse<LiveState>(block.text);
    if (!parsed) return null;

    return {
      keyPoints: (parsed.keyPoints ?? []).slice(0, 7),
      decisions: parsed.decisions ?? [],
      plan: parsed.plan ?? [],
      questions: parsed.questions ?? [],
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
      cachedIn: response.usage.cache_read_input_tokens ?? 0,
    };
  } catch {
    return null;
  }
}
