import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { queueStats } from "@/lib/knowledge/jobs";
import { memoryStats } from "@/lib/knowledge/sources";
import { embeddingConfigured } from "@/lib/knowledge/embeddings";
import { isConfigured } from "@/lib/agents/claude";
import { transcriptionAvailable } from "@/lib/agents/transcribe";

/** How the memory is doing: counts and queue health. Numbers only. */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });
  const [memory, queue] = await Promise.all([memoryStats(), queueStats()]);
  return NextResponse.json({
    memory,
    queue,
    providers: {
      llm: isConfigured(),
      embeddings: embeddingConfigured(),
      transcription: transcriptionAvailable(),
    },
  });
}
