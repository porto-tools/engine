// Create TAR — bundle one or more files into a single uncompressed .tar archive
// (POSIX ustar format), entirely in the browser. A .tar groups files WITHOUT
// compression: it concatenates each file behind a 512-byte header and pads to a
// 512-byte boundary, so the archive is the same size as the inputs plus header
// overhead — it can be slightly LARGER, never smaller. For a compressed bundle,
// use Create ZIP or Gzip instead.
//
// This is a pure-JS ustar writer (no WASM, no new dependency). The format is
// simple and stable enough to implement inline and correctly. `inputMode:
// "multi"` stages the files before running; like images-to-pdf, `file` is
// files[0] and the full list is `files`.
//
// Engine firewall: imports ONLY ../types, ../filename, and ./abort.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { throwIfAborted } from "./abort";

const BLOCK = 512;
// ustar header field offsets/sizes. The name field is 100 bytes; a longer path
// can be split across the 155-byte `prefix` field (joined by '/' on extract).
const NAME_MAX = 100;
const PREFIX_MAX = 155;

const encoder = new TextEncoder();

// Write `value` as a NUL-terminated ASCII string into `block` at [offset, offset+size).
// The caller guarantees the byte length fits (callers validate names up front).
function writeString(block: Uint8Array, offset: number, size: number, value: string): void {
  const bytes = encoder.encode(value);
  block.set(bytes.subarray(0, size), offset);
}

// Write `value` as a zero-padded octal string of `size-1` digits followed by a
// trailing NUL — the ustar convention for numeric fields (size, mtime, mode…).
function writeOctal(block: Uint8Array, offset: number, size: number, value: number): void {
  // size-1 octal digits + 1 NUL terminator.
  const digits = (size - 1);
  const octal = Math.floor(value).toString(8).padStart(digits, "0").slice(-digits);
  writeString(block, offset, size, octal);
  block[offset + size - 1] = 0; // explicit NUL terminator
}

// Split a UTF-8/ASCII path name into a ustar { name (≤100B), prefix (≤155B) }
// pair, or return null if it cannot fit. The split must fall on a '/' so the two
// fields rejoin as `prefix + "/" + name`. We try the rightmost '/' that leaves
// name ≤ 100 and prefix ≤ 155.
export function splitTarName(name: string): { name: string; prefix: string } | null {
  const total = encoder.encode(name).length;
  if (total <= NAME_MAX) return { name, prefix: "" };
  if (total > NAME_MAX + 1 + PREFIX_MAX) return null; // can't fit even with a perfect split

  // Find a '/' such that the tail (after it) is ≤100 bytes and the head ≤155 bytes.
  // Prefer the split that keeps the most in `prefix` (rightmost viable '/').
  for (let i = name.length - 1; i > 0; i--) {
    if (name[i] !== "/") continue;
    const prefix = name.slice(0, i);
    const tail = name.slice(i + 1);
    const tailLen = encoder.encode(tail).length;
    const prefixLen = encoder.encode(prefix).length;
    if (tailLen > 0 && tailLen <= NAME_MAX && prefixLen <= PREFIX_MAX) {
      return { name: tail, prefix };
    }
  }
  return null; // no usable path separator
}

// Build one 512-byte ustar header for a file entry.
//
// Checksum protocol (the one detail that's easy to get wrong): the checksum is
// the unsigned sum of every header byte, computed WITH the 8-byte checksum field
// filled with ASCII spaces (0x20). Once summed, it is written back as a 6-digit
// zero-padded octal number, then a NUL, then a space — occupying the 8-byte
// field. We follow that exactly.
function buildHeader(name: string, prefix: string, size: number, mtime: number): Uint8Array {
  const h = new Uint8Array(BLOCK);

  writeString(h, 0, NAME_MAX, name); // name (100)
  writeOctal(h, 100, 8, 0o644); // mode -> "0000644\0"
  writeOctal(h, 108, 8, 0); // uid  -> "0000000\0"
  writeOctal(h, 116, 8, 0); // gid  -> "0000000\0"
  writeOctal(h, 124, 12, size); // size in octal
  writeOctal(h, 136, 12, mtime); // mtime in octal (epoch seconds)
  // checksum field [148,156): filled with spaces during the sum (done below).
  h[156] = 0x30; // typeflag '0' = regular file
  writeString(h, 257, 6, "ustar\0"); // magic "ustar\0" (6 bytes)
  h[263] = 0x30; // version "00"
  h[264] = 0x30;
  writeString(h, 345, PREFIX_MAX, prefix); // prefix (155)

  // Checksum: fill the 8-byte field with spaces, sum all bytes, then write.
  for (let i = 148; i < 156; i++) h[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  // 6 octal digits, NUL, space.
  writeString(h, 148, 6, (sum & 0o777777).toString(8).padStart(6, "0"));
  h[148 + 6] = 0; // NUL
  h[148 + 7] = 0x20; // space

  return h;
}

// Round `n` up to the next multiple of 512.
function padTo512(n: number): number {
  return Math.ceil(n / BLOCK) * BLOCK;
}

async function convertCreateTar(input: ConversionInput): Promise<ConversionResult> {
  const { files, signal, onProgress } = input;
  const allFiles = files ?? [input.file];

  throwIfAborted(signal);

  if (allFiles.length < 1) {
    throw new ConversionError("Select at least one file to bundle into a .tar.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: "Got 0 files; create-tar requires at least 1.",
    });
  }

  // Validate every name fits the ustar name/prefix fields before doing any work,
  // so we fail fast with a clear message rather than producing a broken archive.
  const splits: { name: string; prefix: string }[] = [];
  for (const f of allFiles) {
    const split = splitTarName(f.name);
    if (split === null) {
      throw new ConversionError(
        `The name "${f.name}" is too long for a .tar archive (limit is 255 bytes, split on a "/").`,
        {
          code: "UNSUPPORTED_INPUT",
          recoverable: false,
          technical: `ustar name field is 100 bytes + 155-byte prefix; "${f.name}" cannot be split to fit.`,
        },
      );
    }
    splits.push(split);
  }

  const inputSize = allFiles.reduce((sum, f) => sum + f.size, 0);
  // mtime: a single archive-creation timestamp (epoch seconds) for every entry.
  const mtime = Math.floor(Date.now() / 1000);

  onProgress?.({ stage: "Bundling files", ratio: 0 });

  // Compute the total archive size up front: per file, one header block + the
  // padded data; then two trailing zero blocks marking end-of-archive.
  let totalSize = 0;
  for (const f of allFiles) totalSize += BLOCK + padTo512(f.size);
  totalSize += 2 * BLOCK;

  let out: Uint8Array<ArrayBuffer>;
  try {
    out = new Uint8Array(new ArrayBuffer(totalSize));
    let offset = 0;

    for (let i = 0; i < allFiles.length; i++) {
      throwIfAborted(signal);

      const f = allFiles[i];
      onProgress?.({ stage: `Adding file ${i + 1} of ${allFiles.length}`, ratio: i / allFiles.length });

      const { name, prefix } = splits[i];
      const header = buildHeader(name, prefix, f.size, mtime);
      out.set(header, offset);
      offset += BLOCK;

      const bytes = new Uint8Array(await f.arrayBuffer());
      throwIfAborted(signal);
      out.set(bytes, offset);
      // Advance past the data AND its zero-padding to the next 512 boundary; the
      // gap is already zero (fresh Uint8Array), so nothing to write.
      offset += padTo512(f.size);

      onProgress?.({ stage: `Adding file ${i + 1} of ${allFiles.length}`, ratio: (i + 1) / allFiles.length });
    }
    // The final two blocks are already zero from the fresh Uint8Array — they are
    // the end-of-archive marker. offset now sits at totalSize.
  } catch (err) {
    if (err instanceof ConversionError) throw err;
    throw new ConversionError("We couldn't build the .tar archive — a file may be damaged.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }

  throwIfAborted(signal);
  onProgress?.({ stage: "Done", ratio: 1 });

  const blob = new Blob([out], { type: "application/x-tar" });
  return {
    blob,
    filename: "archive.tar",
    mimeType: "application/x-tar",
    inputSize,
    outputSize: blob.size,
  };
}

export const createTarDescriptor: ConversionDescriptor = {
  id: "create-tar",
  fromLabel: "Files",
  toLabel: "TAR",
  // A .tar bundles ANY files, so accept everything (no MIME filter).
  accept: [],
  newExtension: "tar",
  inputMode: "multi",
  // One file is a valid (if trivial) archive, so opt the staging guard down to 1.
  minInputs: 1,
  convert: convertCreateTar,
};
