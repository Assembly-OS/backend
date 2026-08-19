import fs from "node:fs";
import { NextResponse } from "next/server";
import { get } from "@/lib/pg";
import { currentUser } from "@/lib/session";
import { canSubmitToAi } from "@/lib/agents/access";
import { parseRange, resolvePath } from "@/lib/uploads";
import { id as parseId } from "@/lib/validate";

/**
 * The document an analysis was run on, reached through the run that read it.
 *
 * The upload is what every assignment in that run traces back to, so it has to
 * stay openable — but it is not a chat message and should not appear as one.
 * `agent_runs.source_ref` has held the storage key since the intake was
 * written; this route is simply the door to it.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const runId = parseId((await params).id);
  if (!runId) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const runRow = await get<{
    source_ref: string | null;
    source_kind: string | null;
    owner_user_id: number | null;
  }>(
    "SELECT source_ref, source_kind, owner_user_id FROM agent_runs WHERE id = ?",
    runId,
  );

  // Whoever submitted it, or anybody who may submit at all — the same people
  // who can already see what the analysis produced.
  if (!runRow || (!canSubmitToAi(user) && runRow.owner_user_id !== user.id))
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

  // A transcript run's `source_ref` is a meeting id, not a storage key.
  if (!runRow.source_ref || runRow.source_kind === "transcript")
    return NextResponse.json({ error: "NO_FILE" }, { status: 404 });

  const path = resolvePath(runRow.source_ref);
  if (!path) return NextResponse.json({ error: "GONE" }, { status: 404 });

  const size = fs.statSync(path).size;
  const name = runRow.source_ref.split("/").pop() ?? "document";
  const mime =
    runRow.source_kind === "pdf"
      ? "application/pdf"
      : runRow.source_kind === "image"
        ? "image/jpeg"
        : "text/plain; charset=utf-8";

  const headers = new Headers({
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    // A PDF or an image the browser renders safely in place; a Word or Excel
    // file it would only ever download, and an arbitrary uploaded file must
    // never be opened inline.
    "Content-Disposition": `${
      runRow.source_kind === "pdf" || runRow.source_kind === "image"
        ? "inline"
        : "attachment"
    }; filename="${name}"`,
  });

  const range = parseRange(request.headers.get("range"), size);
  if (range) {
    const length = range.end - range.start + 1;
    const chunk = Buffer.alloc(length);
    const handle = fs.openSync(path, "r");
    try {
      fs.readSync(handle, chunk, 0, length, range.start);
    } finally {
      fs.closeSync(handle);
    }
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    headers.set("Content-Length", String(length));
    return new NextResponse(new Uint8Array(chunk), { status: 206, headers });
  }

  headers.set("Content-Length", String(size));
  return new NextResponse(new Uint8Array(fs.readFileSync(path)), { headers });
}
