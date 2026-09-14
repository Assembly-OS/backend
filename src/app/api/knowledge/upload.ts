import {
  baseMime,
  extractSource,
  UnsupportedSource,
} from "@/lib/agents/extract";
import { safeName } from "@/lib/uploads";
import { str } from "@/lib/validate";

/**
 * The file part of adding or replacing a library document, shared by both
 * routes so the two cannot disagree about what is accepted.
 *
 * The type is checked here, before anything is stored: a file the library
 * could never read is refused with a reason, not saved and left to fail
 * quietly in the background.
 */

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;

export type ParsedUpload =
  | {
      ok: true;
      bytes: Buffer;
      mime: string;
      name: string;
      format: string;
      title: string | null;
    }
  | { ok: false; error: string; status: number };

export async function parseUpload(request: Request): Promise<ParsedUpload> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { ok: false, error: "BAD_FORM", status: 400 };
  }

  const blob = form.get("file");
  if (!(blob instanceof File) || blob.size === 0)
    return { ok: false, error: "NO_FILE", status: 400 };

  const mime = baseMime(blob.type || "application/octet-stream");
  const limit = mime.startsWith("image/") ? MAX_IMAGE : MAX_BYTES;
  if (blob.size > limit) return { ok: false, error: "TOO_LARGE", status: 413 };

  const bytes = Buffer.from(await blob.arrayBuffer());
  if (bytes.byteLength > limit)
    return { ok: false, error: "TOO_LARGE", status: 413 };

  const name = safeName(blob.name || "hujjat", "file");

  let format: string;
  try {
    format = extractSource(bytes, mime, name).label;
  } catch (error) {
    const message = error instanceof UnsupportedSource ? error.message : "";
    const code = message.startsWith("UNSUPPORTED")
      ? "UNSUPPORTED_TYPE"
      : message === "NO_TEXT" || message === "EMPTY"
        ? "NO_TEXT"
        : "UNREADABLE";
    return { ok: false, error: code, status: 415 };
  }

  return { ok: true, bytes, mime, name, format, title: str(form.get("title"), 200) };
}

/** A file's name without its extension, for a document nobody titled. */
export function defaultTitle(name: string): string {
  return name.replace(/\.[a-z0-9]{1,12}$/i, "").trim() || name;
}
