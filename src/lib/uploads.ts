import { randomBytes } from "node:crypto";
import fs from "node:fs";

/**
 * Chat attachments on disk. Files live outside `public/` on purpose: a
 * conversation is private, so every byte is served through `/api/files/[id]`,
 * which re-checks that the reader is one of the two participants.
 *
 * Note the deliberate absence of `node:path`. Turbopack treats `path.join` /
 * `path.resolve` with an argument it cannot evaluate as "this module may reach
 * any file under that directory", attaches a reference to the directory and
 * enumerates it at build time. Here that directory resolves to the project
 * root, which contains `bot/.venv` and its symlinks out to the system Python —
 * and a symlink leaving the project root aborts the build. Storage keys are a
 * format we define, so plain string handling with an explicit guard is both
 * sufficient and clearer about which shapes are legal.
 */

export type Kind = "text" | "photo" | "voice" | "file";

/** Override to keep attachments off the app volume; defaults beside the DB. */
const UPLOAD_ROOT =
  process.env.ASSAMBLEYA_UPLOAD_DIR || `${process.cwd()}/data/uploads`;

/**
 * Image types every target browser paints inline. SVG is deliberately absent —
 * it is an executable document, and serving one from our own origin would hand
 * an uploader a stored-XSS primitive. SVGs still send fine, just as `file`.
 */
const PHOTO_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

/** What MediaRecorder produces across browsers: Opus/WebM, Ogg, or MP4/AAC. */
const VOICE_TYPES: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

/** Per-kind ceiling, enforced on the real byte length after the read. */
export const MAX_BYTES: Record<Exclude<Kind, "text">, number> = {
  photo: 10 * 1024 * 1024,
  voice: 20 * 1024 * 1024,
  file: 50 * 1024 * 1024,
};

/** Longest voice note we accept, in seconds. */
export const MAX_DURATION = 10 * 60;

/**
 * `audio/webm;codecs=opus` → `audio/webm`. Browsers attach codec parameters to
 * recorder output, so the raw string never matches a bare allow-list key.
 */
export function baseMime(value: string): string {
  return value.split(";")[0].trim().toLowerCase();
}

/**
 * The kind a blob is actually stored as. The client sends a hint, but the
 * decision is made here from the MIME type: an unrenderable "photo" or an
 * audio blob nobody can play degrades to `file` (which always downloads)
 * instead of producing a broken bubble.
 */
export function resolveKind(hint: string, mime: string): Exclude<Kind, "text"> {
  const base = baseMime(mime);
  if (hint === "photo" && base in PHOTO_TYPES) return "photo";
  if (hint === "voice" && base in VOICE_TYPES) return "voice";
  return "file";
}

/** Canonical extension for a stored blob — never taken from the client's name. */
function extensionFor(
  kind: Exclude<Kind, "text">,
  mime: string,
  name: string,
): string {
  const base = baseMime(mime);
  if (kind === "photo") return PHOTO_TYPES[base] ?? "bin";
  if (kind === "voice") return VOICE_TYPES[base] ?? "bin";
  // For a generic file the original suffix is the only hint we have; keep it
  // when it is a plain short alphanumeric one, otherwise drop it.
  return /\.([a-z0-9]{1,12})$/i.exec(name)?.[1]?.toLowerCase() ?? "bin";
}

/**
 * A display name safe to put in a header and render in the UI: no path
 * separators, no control characters, bounded length.
 */
export function safeName(name: string, kind: Exclude<Kind, "text">): string {
  // Control characters would corrupt the Content-Disposition header; the two
  // path separators would let a name pose as a directory in the UI.
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\]/g, "").trim();
  if (cleaned) return cleaned.slice(0, 160);
  return kind === "voice" ? "voice-message" : "file";
}

/** True when the type may be handed to the browser to render in place. */
export function isInline(kind: Kind, mime: string): boolean {
  const base = baseMime(mime);
  if (kind === "photo") return base in PHOTO_TYPES;
  if (kind === "voice") return base in VOICE_TYPES;
  return false;
}

/**
 * The only key shape this module ever writes: `YYYY/MM/<32 hex>.<ext>`.
 * Validating a read against it means a key can never walk out of the root —
 * `..`, an absolute path and a backslash all fail the pattern.
 */
const KEY_PATTERN = /^\d{4}\/\d{2}\/[0-9a-f]{32}\.[a-z0-9]{1,12}$/;

export interface Stored {
  key: string;
  size: number;
}

/**
 * Write bytes under `data/uploads/YYYY/MM/<random>.<ext>` and return the
 * relative key. Sharding by month keeps any one directory small enough that
 * listing it stays fast as the archive grows.
 */
export function store(
  bytes: Uint8Array,
  kind: Exclude<Kind, "text">,
  mime: string,
  name: string,
): Stored {
  const stamp = new Date();
  const year = String(stamp.getUTCFullYear());
  const month = String(stamp.getUTCMonth() + 1).padStart(2, "0");

  fs.mkdirSync(/* turbopackIgnore: true */ `${UPLOAD_ROOT}/${year}/${month}`, {
    recursive: true,
  });

  const key = `${year}/${month}/${randomBytes(16).toString("hex")}.${extensionFor(kind, mime, name)}`;
  fs.writeFileSync(/* turbopackIgnore: true */ `${UPLOAD_ROOT}/${key}`, bytes);
  return { key, size: bytes.byteLength };
}

/**
 * Absolute path for a stored key, or null when the key is not one we could
 * have written, or the file behind it is gone.
 */
export function resolvePath(key: string): string | null {
  if (!KEY_PATTERN.test(key)) return null;
  const full = `${UPLOAD_ROOT}/${key}`;
  return fs.existsSync(/* turbopackIgnore: true */ full) ? full : null;
}

export function read(key: string): Buffer | null {
  const full = resolvePath(key);
  return full ? fs.readFileSync(/* turbopackIgnore: true */ full) : null;
}

/** Best-effort delete — a missing file is already in the desired state. */
export function remove(key: string): void {
  const full = resolvePath(key);
  if (full) {
    try {
      fs.unlinkSync(/* turbopackIgnore: true */ full);
    } catch {
      /* already gone */
    }
  }
}


/**
 * `bytes=START-[END]` → an inclusive, clamped slice, or null when the header is
 * absent or unparseable (both mean "send the whole thing").
 *
 * Safari — and so every iOS webview, including Telegram's — asks for a range
 * before it will play audio at all, and refuses to seek unless the server
 * answers 206. Lives here rather than in one route because two routes now
 * serve media and this is exactly the kind of parsing that drifts when copied.
 */
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match) return null;
  const [, rawStart, rawEnd] = match;

  // "bytes=-500" means the final 500 bytes.
  if (!rawStart) {
    const tail = Number(rawEnd);
    if (!tail) return null;
    return { start: Math.max(0, size - tail), end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Math.min(Number(rawEnd), size - 1) : size - 1;
  if (start > end || start >= size) return null;
  return { start, end };
}
