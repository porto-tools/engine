// Gzip a file — lossless single-file compression to .gz, entirely on-device.
//
// Gzip (RFC 1952) wraps a single DEFLATE stream. It is the right tool for ONE
// file: text, CSV, JSON, logs, source — anything whose bytes are repetitive
// compresses well. It is NOT an archive format: it holds exactly one file, so to
// bundle several files together you want a ZIP instead (see Create ZIP). We say
// this plainly on the page so nobody reaches for gzip expecting a multi-file box.
//
// HONESTY (here and on the page): gzip is LOSSLESS — the original bytes round-trip
// back exactly via gunzip. It shines on text-like data. But files that are ALREADY
// compressed — JPG, PNG, GIF, MP4, MP3, ZIP, most PDFs — have little redundancy
// left, so gzip barely shrinks them and can even add a few bytes of header/footer
// overhead, making the .gz slightly LARGER than the input. That is expected, not a
// bug; we never claim a reduction we didn't achieve, and the before/after size is
// shown exactly as it came out.
//
// Engine firewall: this file imports ONLY ../types, ../filename, ./abort, and
// node_modules (fflate). fflate is the project's existing zip/deflate dependency
// (decision 0006 — no new dep), dynamically imported INSIDE convert so it lands in
// this route's chunk, never the shared/home entry.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { throwIfAborted } from "./abort";

// Gzip APPENDS its extension rather than replacing the source one, unlike every
// format conversion (data.csv → data.csv.gz, not data.gz). The shared
// replaceExtension swaps the final extension, so we append .gz to the whole name
// instead. A trailing dot (e.g. "name.") is trimmed so we never produce "name..gz".
function gzipName(filename: string): string {
  return `${filename.replace(/\.$/, "")}.gz`;
}

async function convert(input: ConversionInput): Promise<ConversionResult> {
  const { file, signal, onProgress } = input;

  throwIfAborted(signal);

  // Gzip accepts any single file, so there's no format to reject. The one input we
  // can't usefully compress is an empty file: there are zero bytes to deflate, so
  // we stop with a clear, honest message rather than emit an empty-payload .gz.
  if (file.size === 0) {
    throw new ConversionError("This file is empty, so there's nothing to compress.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `File "${file.name}" has a size of 0 bytes.`,
    });
  }

  onProgress?.({ stage: "Reading" });
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    throw new ConversionError("We couldn't read this file — it may be damaged.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }

  throwIfAborted(signal);

  // Compress with fflate's synchronous gzip at level 6 — the standard, balanced
  // default (the same level gzip(1) uses): a strong ratio without the time cost of
  // the maximal levels. Reuse of the project's existing fflate dep means no new
  // dependency. The dynamic import keeps fflate out of the shared bundle.
  onProgress?.({ stage: "Compressing" });
  const { gzipSync } = await import("fflate");
  let compressed: Uint8Array;
  try {
    compressed = gzipSync(bytes, { level: 6 });
  } catch (err) {
    // gzipSync is pure and shouldn't throw on valid bytes, but a memory pinch or
    // an unexpected failure is reported honestly rather than swallowed.
    throw new ConversionError("We couldn't compress this file.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }

  throwIfAborted(signal);

  // Wrap in a fresh ArrayBuffer-backed view so the Blob part is a plain
  // Uint8Array<ArrayBuffer> (fflate's return type widens to ArrayBufferLike).
  const blob = new Blob([new Uint8Array(compressed)], { type: "application/gzip" });
  return {
    blob,
    // Append ".gz" on top of the existing name — gzip adds an extension, it does
    // not replace one (data.csv → data.csv.gz, archive.tar → archive.tar.gz).
    filename: gzipName(file.name),
    mimeType: "application/gzip",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const gzipDescriptor: ConversionDescriptor = {
  id: "gzip",
  fromLabel: "File",
  toLabel: "GZ",
  // Any single file is valid input — gzip is format-agnostic.
  accept: [],
  newExtension: "gz",
  convert,
};
