// Create ZIP — bundle one or more files into a single .zip archive, entirely
// on-device. Like images-to-pdf this is a MULTI-FILE input: the UI stages the
// files (inputMode "multi", minInputs 1 — a one-file zip is valid), then a
// single run packs them all into one archive via fflate's zipSync.
//
// HONEST LABELLING: this groups files into one .zip with DEFLATE compression.
// Text and other uncompressed formats shrink; already-compressed files (JPG,
// PNG, MP4, MP3, most office documents, etc.) will NOT meaningfully shrink — a
// ZIP of those is mainly for *grouping* many files into one download, not for
// saving space. The page copy says so plainly.
//
// fflate is the project's existing zip dependency (decision 0006 — no new zip
// dep). It is pure JS (no WASM), so there is no engine download and no
// loadEngine: the dynamic import inside convert() simply keeps fflate in this
// route's chunk, mirroring epub-pdf.ts.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { throwIfAborted } from "./abort";

// Return `name` if unseen, else insert "-2", "-3", … before the extension until
// unique, recording the chosen name in `used`. ZIP entries are keyed by path, so
// two staged files with the same name would otherwise silently overwrite each
// other inside the archive — disambiguate them exactly as images-to-pdf does for
// its output filenames. Mirrors the filename rule: split on the LAST dot, and a
// leading-dot dotfile (".env") has no extension to keep the suffix ahead of.
function uniqueName(name: string, used: Set<string>): string {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

async function convertCreateZip(input: ConversionInput): Promise<ConversionResult> {
  const { files, signal, onProgress } = input;
  // `file` is files[0] in multi mode; fall back to it so a single-file run works.
  const allFiles = files ?? [input.file];

  throwIfAborted(signal);

  if (allFiles.length < 1) {
    throw new ConversionError("Add at least one file to put in the ZIP.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: "Got 0 files; create-zip requires at least 1.",
    });
  }

  // Read every file's bytes into the fflate input map, disambiguating duplicate
  // names so no entry overwrites another inside the archive.
  onProgress?.({ stage: "Reading files", ratio: 0 });
  const entries: Record<string, Uint8Array> = {};
  const usedNames = new Set<string>();

  for (let i = 0; i < allFiles.length; i++) {
    throwIfAborted(signal);
    const f = allFiles[i];
    onProgress?.({ stage: `Reading file ${i + 1} of ${allFiles.length}`, ratio: i / allFiles.length });

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await f.arrayBuffer());
    } catch (err) {
      throw new ConversionError(`We couldn't read "${f.name}" — the file may be damaged.`, {
        code: "DECODE_FAILED",
        recoverable: false,
        technical: err instanceof Error ? err.message : String(err),
      });
    }
    // Use just the basename — a dropped file's `name` is already a bare filename,
    // but strip any path segments defensively so we never write nested folders.
    const baseName = f.name.split(/[\\/]/).pop() || f.name || `file-${i + 1}`;
    entries[uniqueName(baseName, usedNames)] = bytes;
  }

  throwIfAborted(signal);

  // Pack with fflate. Lazy-import so it stays in the /create-zip route chunk only
  // (mirrors epub-pdf.ts). fflate is pure JS, so there's no WASM/engine load to
  // fail — the other error paths (UNSUPPORTED_INPUT, DECODE_FAILED, CANCELLED)
  // cover everything that can realistically go wrong here.
  onProgress?.({ stage: "Compressing", ratio: undefined });
  const { zipSync } = await import("fflate");

  let archive: Uint8Array;
  try {
    // level 6 = balanced DEFLATE (zip's default). Already-compressed inputs won't
    // shrink; that's expected and stated honestly on the page.
    archive = zipSync(entries, { level: 6 });
  } catch (err) {
    throw new ConversionError("We couldn't build the ZIP archive from these files.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }

  throwIfAborted(signal);

  onProgress?.({ stage: "Saving" });
  // Copy into a fresh Uint8Array so the Blob gets a plain ArrayBuffer backing.
  const blob = new Blob([new Uint8Array(archive)], { type: "application/zip" });
  const inputSize = allFiles.reduce((sum, f) => sum + f.size, 0);

  // Single file → name the archive after it (foo.png → foo.zip); multiple files →
  // a neutral "archive.zip".
  const filename = allFiles.length === 1 ? replaceExtension(allFiles[0].name, "zip") : "archive.zip";

  return {
    blob,
    filename,
    mimeType: "application/zip",
    inputSize,
    outputSize: blob.size,
  };
}

export const createZipDescriptor: ConversionDescriptor = {
  id: "create-zip",
  fromLabel: "Files",
  toLabel: "ZIP",
  // Accept any file type — a ZIP can hold anything. Empty `accept` means the
  // dropzone doesn't filter by MIME.
  accept: [],
  newExtension: "zip",
  inputMode: "multi",
  // One file is a valid (if pointless) archive; staging shouldn't force a second.
  minInputs: 1,
  convert: convertCreateZip,
};

// Exported for unit tests of the pure helper (no behaviour change for callers).
export const __test = { uniqueName };
