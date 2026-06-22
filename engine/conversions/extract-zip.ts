// Extract ZIP — unzip a standard .zip into its individual files, entirely on the
// user's device. Single .zip IN → MULTIPLE files OUT (one per entry), rendered
// by the shared MultiResultCard (per-file downloads + "Download all").
//
// We unzip with fflate (the project's existing zip dep — decision 0006, no new
// zip dependency), dynamically imported inside convert so it lands in this route
// chunk rather than the shared entry. fflate's unzipSync returns a flat
// Record<entryName, Uint8Array>; we drop directory entries, sanitise each name
// against path traversal, and hand back one ConversionOutput per real file.
//
// HONESTY: this extracts a STANDARD, non-encrypted ZIP. fflate cannot decrypt
// password-protected (encrypted) ZIPs, so those surface as DECODE_FAILED with a
// plain-language message. We say so on the page too.
//
// FIREWALL: this file imports ONLY sibling engine modules (../types, ../filename,
// ./abort) and node_modules (fflate). It never reaches into app/components/lib —
// the contract that keeps the future @porto-tools/engine extraction mechanical.

import type {
  ConversionDescriptor,
  ConversionInput,
  ConversionOutput,
  ConversionResult,
} from "../types";
import { ConversionError } from "../types";
import { throwIfAborted } from "./abort";

// Accept the two common ZIP MIME types, and tolerate an empty MIME when the
// filename ends .zip — many OSes/browsers report "" for .zip on drop (same
// tolerance the EPUB/MP4 routes apply).
const ZIP_MIME_TYPES = ["application/zip", "application/x-zip-compressed"];

function isZipFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (ZIP_MIME_TYPES.includes(type)) return true;
  if (type === "") {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    return ext === "zip";
  }
  return false;
}

// Map a handful of common extensions to a sensible MIME type so downloads open
// in the right app. Anything we don't recognise falls back to a safe generic
// binary type; the browser still downloads it correctly by filename.
const EXTENSION_MIME: Record<string, string> = {
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  zip: "application/zip",
};

function mimeForName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_MIME[ext] ?? "application/octet-stream";
}

// Sanitise a zip entry name into a safe download basename. ZIP entry names can
// carry directory paths and, in malicious archives, traversal segments
// ("../../etc/passwd") or absolute paths ("/etc/passwd"). Since each extracted
// file is downloaded on its own (never written to a directory tree), we strip
// every path component and keep only the final basename — this neutralises
// traversal entirely. Leading slashes and ".."/"." segments are dropped before
// taking the basename as defence in depth.
function safeBasename(entryName: string): string {
  const segments = entryName
    .split(/[\\/]+/) // split on both / and \ (Windows-authored zips use \)
    .filter((seg) => seg !== "" && seg !== "." && seg !== "..");
  return segments.length > 0 ? segments[segments.length - 1] : "";
}

async function convertExtractZip(input: ConversionInput): Promise<ConversionResult> {
  const { file, signal, onProgress } = input;

  throwIfAborted(signal);

  if (!isZipFile(file)) {
    throw new ConversionError("This doesn't look like a ZIP file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected a .zip (${ZIP_MIME_TYPES.join(" / ")}), received "${
        file.type || "unknown type"
      }".`,
    });
  }

  onProgress?.({ stage: "Reading ZIP" });
  let archiveBytes: Uint8Array;
  try {
    archiveBytes = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    throw new ConversionError("We couldn't read this file — it may be damaged.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }

  throwIfAborted(signal);

  // Unzip with fflate (reuse the project's existing zip dep — no new zip dep).
  // Dynamic import keeps it in this route chunk. unzipSync throws on a corrupt
  // archive; it also can't decrypt encrypted (password-protected) entries.
  onProgress?.({ stage: "Extracting" });
  const { unzipSync } = await import("fflate");
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(archiveBytes);
  } catch (err) {
    throw new ConversionError(
      "We couldn't read this ZIP — it may be corrupt or password-protected.",
      {
        code: "DECODE_FAILED",
        recoverable: false,
        technical: err instanceof Error ? err.message : String(err),
      },
    );
  }

  throwIfAborted(signal);

  const outputs: ConversionOutput[] = [];
  const usedNames = new Set<string>();

  for (const [entryName, bytes] of Object.entries(entries)) {
    throwIfAborted(signal);

    // SKIP directory entries: fflate emits them with a trailing slash and an
    // empty buffer. Zero-byte entries whose name resolves to a directory
    // placeholder carry no file content, so they're skipped too.
    if (entryName.endsWith("/") || entryName.endsWith("\\")) continue;

    const base = safeBasename(entryName);
    if (!base) continue; // name was entirely path/traversal segments — nothing safe to keep

    // De-duplicate basenames: two entries in different folders can share a leaf
    // name once paths are stripped. Suffix collisions so every download is
    // distinct ("photo.png", "photo (2).png", …).
    let filename = base;
    if (usedNames.has(filename)) {
      const dot = base.lastIndexOf(".");
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : "";
      let n = 2;
      while (usedNames.has(`${stem} (${n})${ext}`)) n++;
      filename = `${stem} (${n})${ext}`;
    }
    usedNames.add(filename);

    const mimeType = mimeForName(filename);
    // Copy into a fresh ArrayBuffer-backed Blob; fflate's Uint8Array may be a
    // view over the shared archive buffer.
    const blob = new Blob([bytes.slice().buffer], { type: mimeType });
    outputs.push({ blob, filename, mimeType, size: blob.size });
  }

  if (outputs.length < 1) {
    // A valid but empty archive (or one with only directory entries): a
    // recoverable nudge rather than a crash on outputs[0] below.
    throw new ConversionError("This ZIP has no files to extract.", {
      code: "DECODE_FAILED",
      recoverable: true,
      technical: `Archive parsed but contained ${
        Object.keys(entries).length
      } entr(y/ies), none of them extractable files.`,
    });
  }

  onProgress?.({ stage: "Done", ratio: 1 });

  const outputSize = outputs.reduce((sum, o) => sum + o.size, 0);
  const first = outputs[0];
  return {
    blob: first.blob,
    filename: first.filename,
    mimeType: first.mimeType,
    inputSize: file.size,
    outputSize,
    outputs,
  };
}

export const extractZipDescriptor: ConversionDescriptor = {
  id: "extract-zip",
  fromLabel: "ZIP",
  toLabel: "Files",
  // Standard ZIP MIME types; an empty MIME with a .zip name is tolerated in
  // convert() (isZipFile).
  accept: ["application/zip", "application/x-zip-compressed"],
  newExtension: "",
  outputMode: "multi",
  // No WASM engine: fflate is a tiny pure-JS dep, dynamically imported inside
  // convert. So no loadEngine / setupSizeLabel.
  convert: convertExtractZip,
};
