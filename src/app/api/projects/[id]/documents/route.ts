import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { projectRights } from "@/lib/project-visibility";
import { addDocument, isDocumentKind } from "@/lib/project-documents";
import { MAX_BYTES, baseMime, safeName, store } from "@/lib/uploads";
import { id as parseId, str } from "@/lib/validate";

/**
 * Adds a document to a project's passport: a master plan, a feasibility
 * study, an ESG assessment, a legal paper. TZ block 1.3.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "AUTH" }, { status: 401 });

  const projectId = parseId((await params).id);
  const project = projectId ? await projectRights(user, projectId) : null;
  if (!project) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  if (!project.keepDocuments)
    return NextResponse.json({ error: "FORBIDDEN" }, { status: 403 });

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "BAD_FORM" }, { status: 400 });
  }

  const kind = form.get("kind");
  if (!isDocumentKind(kind))
    return NextResponse.json({ error: "BAD_KIND" }, { status: 400 });

  const blob = form.get("file");
  if (!(blob instanceof File) || blob.size === 0)
    return NextResponse.json({ error: "NO_FILE" }, { status: 400 });
  if (blob.size > MAX_BYTES.file)
    return NextResponse.json({ error: "TOO_LARGE" }, { status: 413 });

  const bytes = Buffer.from(await blob.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES.file)
    return NextResponse.json({ error: "TOO_LARGE" }, { status: 413 });

  const name = safeName(blob.name || "hujjat", "file");
  // A document nobody titled is called what its file is called, without the
  // extension — the name somebody gave the file is usually the right one.
  const title =
    str(form.get("title"), 200) ?? (name.replace(/\.[a-z0-9]{1,12}$/i, "").trim() || name);
  const stored = store(bytes, "file", baseMime(blob.type || "application/octet-stream"), name);

  const id = await addDocument({
    projectId: project.id,
    kind,
    title,
    file: { key: stored.key, name, size: stored.size },
    userId: user.id,
  });
  return NextResponse.json({ id }, { status: 201 });
}
