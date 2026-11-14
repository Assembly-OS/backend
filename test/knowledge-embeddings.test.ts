import { test } from "node:test";
import assert from "node:assert/strict";
import { embeddingProvider, vectorLiteral } from "../src/lib/knowledge/embeddings.ts";

function fakeFetch(reply: (url: string, init: RequestInit) => unknown) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, body });
    const out = reply(url, init ?? {});
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

function vectors(n: number) {
  return { data: Array.from({ length: n }, (_, index) => ({ index, embedding: [index, 1] })) };
}

test("no key, no provider — the memory runs on words alone", () => {
  assert.equal(embeddingProvider({}), null);
  assert.equal(embeddingProvider({ EMBEDDING_PROVIDER: "none", VOYAGE_API_KEY: "k" }), null);
  assert.equal(embeddingProvider({ EMBEDDING_PROVIDER: "voyage" }), null);
});

test("the provider follows the key that is set, voyage first", () => {
  assert.equal(embeddingProvider({ VOYAGE_API_KEY: "v" })?.name, "voyage");
  assert.equal(embeddingProvider({ OPENAI_API_KEY: "o" })?.name, "openai");
  assert.equal(embeddingProvider({ VOYAGE_API_KEY: "v", OPENAI_API_KEY: "o" })?.name, "voyage");
  assert.equal(embeddingProvider({ VOYAGE_API_KEY: "v", OPENAI_API_KEY: "o", EMBEDDING_PROVIDER: "openai" })?.name, "openai");
  assert.equal(embeddingProvider({ VOYAGE_API_KEY: "v", EMBEDDING_MODEL: "voyage-x" })?.model, "voyage-x");
});

test("voyage is asked with the input type, and vectors come back in order", async () => {
  const { impl, calls } = fakeFetch((_url, init) => vectors((JSON.parse(String(init.body)) as { input: string[] }).input.length));
  const provider = embeddingProvider({ VOYAGE_API_KEY: "secret" }, impl)!;
  const out = await provider.embed(["a", "b"], "query");
  assert.deepEqual(out, [[0, 1], [1, 1]]);
  assert.equal(calls[0].url, "https://api.voyageai.com/v1/embeddings");
  assert.equal(calls[0].body.input_type, "query");
  assert.equal(calls[0].body.model, "voyage-3.5");
});

test("openai gets the same texts without an input type; long inputs are batched", async () => {
  const { impl, calls } = fakeFetch((_url, init) => vectors((JSON.parse(String(init.body)) as { input: string[] }).input.length));
  const provider = embeddingProvider({ OPENAI_API_KEY: "secret" }, impl)!;
  const out = await provider.embed(Array.from({ length: 100 }, (_, i) => `t${i}`), "document");
  assert.equal(out.length, 100);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, "https://api.openai.com/v1/embeddings");
  assert.equal(calls[0].body.input_type, undefined);
});

test("a provider failure throws, so the job is retried rather than stored empty", async () => {
  const { impl } = fakeFetch(() => new Response("rate limited", { status: 429 }));
  const provider = embeddingProvider({ VOYAGE_API_KEY: "secret" }, impl)!;
  await assert.rejects(() => provider.embed(["a"], "document"), /429/);
});

test("a vector is written as a Postgres array literal", () => {
  assert.equal(vectorLiteral([0.5, 1, Number.NaN]), "{0.5000000,1.000000,0}");
});
