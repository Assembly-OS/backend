import { createServer, type Server } from "node:http";

/**
 * A stand-in for the two vendors the memory talks to, so the tests run
 * the real code paths — the SDK, the request shapes, the parsing — with
 * answers the test decides.
 *
 * `/v1/messages` answers with whatever `onMessages` returns for the request
 * body; `/v1/embeddings` returns deterministic vectors: a bag of character
 * trigrams hashed into 32 dimensions, so two texts about the same words
 * land near each other, which is all the retrieval tests need.
 */

export interface Stub {
  url: string;
  calls: { path: string; body: Record<string, unknown> }[];
  close(): Promise<void>;
}

export function embed(text: string): number[] {
  const vector = new Array<number>(32).fill(0);
  const flat = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ");
  for (const word of flat.split(" ")) {
    if (word.length < 3) continue;
    for (let i = 0; i + 3 <= word.length; i++) {
      const gram = word.slice(i, i + 3);
      let hash = 0;
      for (const ch of gram) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
      vector[hash % 32] += 1;
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

export type MessagesHandler = (
  body: Record<string, unknown>,
  calls: Stub["calls"],
) => Record<string, unknown>;

/** A plain text answer in the Messages API's shape. */
export function textReply(text: string): Record<string, unknown> {
  return {
    id: "msg_stub",
    type: "message",
    role: "assistant",
    model: "claude-stub",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

/** A tool call in the Messages API's shape. */
export function toolReply(name: string, input: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "msg_stub",
    type: "message",
    role: "assistant",
    model: "claude-stub",
    content: [{ type: "tool_use", id: `toolu_${name}`, name, input }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

export function startStub(onMessages: MessagesHandler): Promise<Stub> {
  const calls: Stub["calls"] = [];
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const path = request.url ?? "";
      calls.push({ path, body });
      let reply: Record<string, unknown>;
      if (path.startsWith("/v1/embeddings")) {
        const input = body.input as string[];
        reply = {
          object: "list",
          data: input.map((text, index) => ({ object: "embedding", index, embedding: embed(text) })),
          model: String(body.model),
        };
      } else if (path.includes("/v1/messages")) {
        reply = onMessages(body, calls);
      } else {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(reply));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        close: () =>
          new Promise((done) => {
            // Keep-alive sockets from the SDK would hold the server open.
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
