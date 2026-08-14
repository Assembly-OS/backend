import { inflateRawSync } from "node:zlib";

/**
 * Turning an uploaded file into something the model can read.
 *
 * Three routes, picked by type:
 *  - PDF and images go to the API untouched, as `document` / `image` blocks.
 *    The model reads the page itself, so a scan or a photo of a signed order
 *    works as well as a digital file.
 *  - Word, Excel and PowerPoint have no native block, so their text is pulled
 *    out here. All three are ZIP archives of XML — no dependency needed, and
 *    the alternative (shipping the binary to a sandbox to be parsed) costs a
 *    round trip and tokens for the same words.
 *  - Plain text and CSV are already text.
 *
 * Extraction is deliberately plain: paragraphs, cells and slides in reading
 * order. Formatting carries no instruction, and a faithful layout would cost
 * tokens that the model spends better on the content.
 */

export type SourceKind = "pdf" | "image" | "text";

export interface ExtractedSource {
  kind: SourceKind;
  /** For `text`: the extracted words. Empty for pdf/image. */
  text: string;
  /** Media type to send to the API — always one the API accepts. */
  mediaType: string;
  /** What the file was, for the audit trail and the UI. */
  label: string;
}

const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const OOXML: Record<string, string> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "Word",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "Excel",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "PowerPoint",
};

const TEXT_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

/** Every type the intake accepts, for the file picker and the error message. */
export const ACCEPTED = [
  "application/pdf",
  ...IMAGE_TYPES,
  ...Object.keys(OOXML),
  ...TEXT_TYPES,
].join(",");

export function baseMime(value: string): string {
  return value.split(";")[0].trim().toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Minimal ZIP reader — enough for OOXML, nothing more                 */
/* ------------------------------------------------------------------ */

interface ZipEntry {
  name: string;
  method: number;
  offset: number;
  compressed: number;
}

/**
 * Reads the central directory rather than scanning for local headers: a file
 * written in streaming mode leaves the sizes out of the local header and puts
 * them in a trailing descriptor, so header-scanning silently truncates.
 */
function readCentralDirectory(zip: Buffer): ZipEntry[] {
  // The end-of-central-directory record sits in the last 64KB (the comment
  // that may follow it is bounded by the format at 65535 bytes).
  const from = Math.max(0, zip.length - 66_000);
  let eocd = -1;
  for (let i = zip.length - 22; i >= from; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return [];

  const count = zip.readUInt16LE(eocd + 10);
  let cursor = zip.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let index = 0; index < count && cursor + 46 <= zip.length; index++) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) break;
    const method = zip.readUInt16LE(cursor + 10);
    const compressed = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const offset = zip.readUInt32LE(cursor + 42);
    const name = zip
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");

    entries.push({ name, method, offset, compressed });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntry(zip: Buffer, entry: ZipEntry): string {
  if (entry.offset + 30 > zip.length) return "";
  if (zip.readUInt32LE(entry.offset) !== 0x04034b50) return "";

  const nameLength = zip.readUInt16LE(entry.offset + 26);
  const extraLength = zip.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLength + extraLength;
  const body = zip.subarray(start, start + entry.compressed);

  try {
    // 0 = stored, 8 = deflate. OOXML uses nothing else.
    if (entry.method === 0) return body.toString("utf8");
    if (entry.method === 8) return inflateRawSync(body).toString("utf8");
  } catch {
    /* a corrupt member yields nothing rather than failing the whole file */
  }
  return "";
}

/* ------------------------------------------------------------------ */
/* XML → text                                                          */
/* ------------------------------------------------------------------ */

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
};

function unescapeXml(value: string): string {
  return value.replace(
    /&(amp|lt|gt|quot|apos|#39);/g,
    (match) => ENTITIES[match] ?? match,
  );
}

/** Strips markup, turning the given closing tags into line breaks first. */
function stripTags(xml: string, breakOn: string[]): string {
  let text = xml;
  for (const tag of breakOn) text = text.split(tag).join("\n");
  text = text.replace(/<[^>]*>/g, "");
  return unescapeXml(text)
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function extractDocx(zip: Buffer, entries: ZipEntry[]): string {
  const main = entries.find((entry) => entry.name === "word/document.xml");
  if (!main) return "";
  // `</w:p>` ends a paragraph, `</w:tr>` a table row.
  return stripTags(readEntry(zip, main), ["</w:p>", "</w:tr>"]);
}

function extractPptx(zip: Buffer, entries: ZipEntry[]): string {
  const slides = entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true }),
    );

  return slides
    .map((slide, index) => {
      const text = stripTags(readEntry(zip, slide), ["</a:p>"]);
      return text ? `--- Slayd ${index + 1} ---\n${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Excel keeps most strings in one shared table and references them by index,
 * so the sheets alone read as a list of numbers. Resolve the table first.
 */
function extractXlsx(zip: Buffer, entries: ZipEntry[]): string {
  const sharedEntry = entries.find(
    (entry) => entry.name === "xl/sharedStrings.xml",
  );
  const shared: string[] = [];
  if (sharedEntry) {
    const xml = readEntry(zip, sharedEntry);
    for (const item of xml.split("<si>").slice(1)) {
      const parts = [...item.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(
        (match) => unescapeXml(match[1]),
      );
      shared.push(parts.join(""));
    }
  }

  const sheets = entries
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry.name))
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true }),
    );

  const out: string[] = [];
  for (const [index, sheet] of sheets.entries()) {
    const xml = readEntry(zip, sheet);
    const rows: string[] = [];

    for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cellMatch of rowMatch[1].matchAll(
        /<c[^>]*?(?:\st="([^"]*)")?[^>]*>([\s\S]*?)<\/c>/g,
      )) {
        const type = cellMatch[1];
        const inner = cellMatch[2];
        const value = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";

        if (type === "s") {
          cells.push(shared[Number(value)] ?? "");
        } else if (type === "inlineStr") {
          const inline = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
            .map((match) => unescapeXml(match[1]))
            .join("");
          cells.push(inline);
        } else {
          cells.push(unescapeXml(value));
        }
      }
      const line = cells.join("\t").trim();
      if (line) rows.push(line);
    }

    if (rows.length > 0) {
      out.push(`--- Varaq ${index + 1} ---\n${rows.join("\n")}`);
    }
  }
  return out.join("\n\n");
}

/* ------------------------------------------------------------------ */

export class UnsupportedSource extends Error {}

/**
 * Classifies an upload and, where needed, pulls its text out. Throws
 * `UnsupportedSource` for a type the intake does not accept, and for an
 * office file that yielded nothing readable — a silent empty analysis would
 * look like "the document contained no assignments", which is a different
 * and much more misleading statement.
 */
export function extractSource(
  bytes: Buffer,
  mime: string,
  fileName: string,
): ExtractedSource {
  const type = baseMime(mime);

  if (type === "application/pdf") {
    return { kind: "pdf", text: "", mediaType: type, label: "PDF" };
  }

  if (IMAGE_TYPES.has(type)) {
    return { kind: "image", text: "", mediaType: type, label: "Rasm" };
  }

  if (TEXT_TYPES.has(type)) {
    const text = bytes.toString("utf8").trim();
    if (!text) throw new UnsupportedSource("EMPTY");
    return { kind: "text", text, mediaType: "text/plain", label: "Matn" };
  }

  const office = OOXML[type];
  if (office) {
    const entries = readCentralDirectory(bytes);
    if (entries.length === 0) throw new UnsupportedSource("BAD_ARCHIVE");

    const text =
      office === "Word"
        ? extractDocx(bytes, entries)
        : office === "Excel"
          ? extractXlsx(bytes, entries)
          : extractPptx(bytes, entries);

    if (!text.trim()) throw new UnsupportedSource("NO_TEXT");
    return { kind: "text", text, mediaType: "text/plain", label: office };
  }

  throw new UnsupportedSource(`UNSUPPORTED:${type || fileName}`);
}
