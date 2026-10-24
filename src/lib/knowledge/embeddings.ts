/**
 * Embeddings — matching by meaning, when a provider is configured.
 *
 * Anthropic's API has no embeddings endpoint, so this is the one place the
 * memory talks to a second vendor, and it is optional: without a key the
 * memory runs on word matching alone, which already finds most of what is
 * asked for. With one, a question in Russian finds a passage in Uzbek that
 * says the same thing in different words.
 *
 * Configuration (environment):
 *   EMBEDDING_PROVIDER = voyage | openai | none   (default: whichever key is set)
 *   VOYAGE_API_KEY / OPENAI_API_KEY
 *   EMBEDDING_MODEL                               (default per provider below)
 *   EMBEDDING_BASE_URL                            (tests and proxies only)
 *
 * The provider is called over plain HTTPS rather than through an SDK: two
 * endpoints with one request shape each do not justify a dependency, and a
 * fake `fetch` is all the tests need to exercise everything here.
 */

export type EmbeddingInput = "document" | "query";

export interface EmbeddingProvider {
  name: "voyage" | "openai";
  model: string;
  /** Vectors in the order of `texts`. Throws on a provider failure. */
  embed(texts: string[], kind: EmbeddingInput): Promise<number[][]>;
}

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

/** Past this a passage is cut before embedding; a page is far below it. */
const MAX_CHARS = 8_000;
/** Texts per request: both vendors accept far more, this keeps requests small. */
const BATCH = 48;

const DEFAULT_MODEL = { voyage: "voyage-3.5", openai: "text-embedding-3-small" } as const;

async function post(
  fetchImpl: Fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<number[][]> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`embeddings ${response.status}: ${detail}`);
  }
  const parsed = (await response.json()) as {
    data?: { index?: number; embedding?: number[] }[];
  };
  const rows = parsed.data ?? [];
  // Both vendors return items in order and carry an index; trust the index.
  const out: number[][] = [];
  rows.forEach((row, position) => {
    const vector = row.embedding;
    if (!Array.isArray(vector)) throw new Error("embeddings: malformed vector");
    out[row.index ?? position] = vector;
  });
  if (out.length !== rows.length || out.some((vector) => !vector))
    throw new Error("embeddings: incomplete response");
  return out;
}

function batched(texts: string[]): string[][] {
  const batches: string[][] = [];
  for (let start = 0; start < texts.length; start += BATCH)
    batches.push(texts.slice(start, start + BATCH).map((text) => text.slice(0, MAX_CHARS)));
  return batches;
}

/**
 * The configured provider, or null when there is none. Read from the
 * environment on every call: a key added after boot should start working
 * without a restart of a process that may be in the middle of a backfill.
 */
export function embeddingProvider(
  env: Env = process.env,
  fetchImpl: Fetch = fetch,
): EmbeddingProvider | null {
  const choice = (env.EMBEDDING_PROVIDER ?? "").trim().toLowerCase();
  if (choice === "none" || choice === "off") return null;

  const voyageKey = env.VOYAGE_API_KEY?.trim();
  const openaiKey = env.OPENAI_API_KEY?.trim();
  const name =
    choice === "voyage" || choice === "openai"
      ? choice
      : voyageKey
        ? "voyage"
        : openaiKey
          ? "openai"
          : null;
  if (!name) return null;

  const model = env.EMBEDDING_MODEL?.trim() || DEFAULT_MODEL[name];
  const base =
    env.EMBEDDING_BASE_URL?.trim().replace(/\/$/, "") ||
    (name === "voyage" ? "https://api.voyageai.com" : "https://api.openai.com");

  if (name === "voyage") {
    if (!voyageKey) return null;
    return {
      name,
      model,
      async embed(texts, kind) {
        const out: number[][] = [];
        for (const batch of batched(texts)) {
          out.push(
            ...(await post(
              fetchImpl,
              `${base}/v1/embeddings`,
              { Authorization: `Bearer ${voyageKey}` },
              { input: batch, model, input_type: kind },
            )),
          );
        }
        return out;
      },
    };
  }

  if (!openaiKey) return null;
  return {
    name,
    model,
    async embed(texts) {
      const out: number[][] = [];
      for (const batch of batched(texts)) {
        out.push(
          ...(await post(
            fetchImpl,
            `${base}/v1/embeddings`,
            { Authorization: `Bearer ${openaiKey}` },
            { input: batch, model },
          )),
        );
      }
      return out;
    },
  };
}

export function embeddingConfigured(env: Env = process.env): boolean {
  return embeddingProvider(env) !== null;
}

/** A vector as Postgres reads an array literal: `{0.1,0.2,…}`. */
export function vectorLiteral(vector: number[]): string {
  return `{${vector.map((value) => (Number.isFinite(value) ? value.toPrecision(7) : "0")).join(",")}}`;
}
