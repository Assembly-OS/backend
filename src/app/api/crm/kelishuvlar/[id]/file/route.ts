import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { canWrite, crmRole } from "@/lib/crm-access";
import { get, now, tx, type Tx } from "@/lib/pg";
import { MAX_BYTES, baseMime, read, safeName, store } from "@/lib/uploads";
import type { User } from "@/lib/types";
import { id as parseId } from "@/lib/validate";

/**
 * The signed copy of an agreement — TZ block 1.2, "hujjat fayli: imzolangan
 * nusxa".
 *
 * One current file per agreement. Replacing or removing it is an UPDATE, which
 * the archive trigger does not see, so the pointer to the earlier file is
 * written into `archive` here and its bytes are left where they are: the copy
 * that was actually signed is the last thing the memory should lose.
 */

type Params = { params: Promise<{ id: string }> };

interface CopyRow {
  created_by: number | null;
  responsible_id: number | null;
  file_key: string | null;
  file_name: string | null;
  file_size: number | null;
}

async function loadCopy(id: number): Promise<CopyRow | undefined> {
  return await get<CopyRow>(
    `SELECT created_by, responsible_id, file_key, file_name, file_size
       FROM kelishuvlar WHERE id = ?`,
    id,
  );
}

/** The same three who may edit the agreement itself. */
function mayEdit(user: User, row: CopyRow): boolean {
  return (
    canWrite(user) &&
    (row.created_by === user.id ||
      row.responsible_id === user.id ||
      crmRole(user) === "admin")
  );
}

async function archivePreviousCopy(
  q: Tx,
  id: number,
  row: CopyRow,
  userId: number,
): Promise<void> {
  if (!row.file_key) return;
  await q.run(
    `INSERT INTO archive (table_name, row_id, row_data, archived_by)
     VALUES ('kelishuvlar.file', ?, ?::jsonb, ?)`,
    id,
    JSON.stringify({
      file_key: row.file_key,
      file_name: row.file_name,
      file_size: row.file_size,
    }),
    userId,
  );
}

/** Download. Whoever may open the agreement page may open its copy. */
export async function GET(_request: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const row = await loadCopy(id);
  if (!row?.file_key)
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (!canWrite(user) && row.responsible_id !== user.id)
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  const bytes = read(row.file_key);
  if (!bytes) return NextResponse.json({ error: "GONE" }, { status: 404 });

  return new Response(new Uint8Array(bytes), {
    headers: {
      // Always a download: an uploaded HTML or SVG file must not run on this
      // origin. The sandbox policy for this path is set in next.config.ts.
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.file_name ?? "kelishuv")}`,
      "X-Content-Type-Options": "nosniff",
      // The same URL serves a different file after a replace.
      "Cache-Control": "private, no-cache",
      "Content-Length": String(bytes.byteLength),
    },
  });
}

/** Upload, or replace the current copy. */
export async function POST(request: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const row = await loadCopy(id);
  if (!row) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (!mayEdit(user, row))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "BAD_FORM" }, { status: 400 });
  }
  const blob = form.get("file");
  if (!(blob instanceof File) || blob.size === 0)
    return NextResponse.json({ error: "NO_FILE" }, { status: 400 });
  if (blob.size > MAX_BYTES.file)
    return NextResponse.json({ error: "TOO_LARGE" }, { status: 413 });

  const bytes = Buffer.from(await blob.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES.file)
    return NextResponse.json({ error: "TOO_LARGE" }, { status: 413 });

  const name = safeName(blob.name || "kelishuv", "file");
  const stored = store(bytes, "file", baseMime(blob.type || "application/octet-stream"), name);

  await tx(async (q) => {
    await archivePreviousCopy(q, id, row, user.id);
    await q.run(
      `UPDATE kelishuvlar
          SET file_key = ?, file_name = ?, file_size = ?, updated_at = ?
        WHERE id = ?`,
      stored.key,
      name,
      stored.size,
      now(),
      id,
    );
  });

  return NextResponse.json({ ok: true, file_name: name, file_size: stored.size });
}

/** Take the copy off the agreement. The file itself stays in the archive. */
export async function DELETE(_request: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const id = parseId((await params).id);
  if (!id) return NextResponse.json({ error: "BAD_ID" }, { status: 400 });

  const row = await loadCopy(id);
  if (!row) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (!mayEdit(user, row))
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });
  if (!row.file_key) return NextResponse.json({ ok: true });

  await tx(async (q) => {
    await archivePreviousCopy(q, id, row, user.id);
    await q.run(
      `UPDATE kelishuvlar
          SET file_key = NULL, file_name = NULL, file_size = NULL, updated_at = ?
        WHERE id = ?`,
      now(),
      id,
    );
  });
  return NextResponse.json({ ok: true });
}
