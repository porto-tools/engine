// create-tar is a pure-JS ustar writer — no WASM, no browser APIs beyond File /
// Blob (both available in the vitest environment), so every test runs for real.
// We verify the output by parsing it with a tiny in-test ustar reader rather than
// trusting the writer's own constants.

import { describe, it, expect } from "vitest";
import { createTarDescriptor, splitTarName } from "./create-tar";

const BLOCK = 512;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function fileOf(name: string, bytes: Uint8Array | string, type = "application/octet-stream"): File {
  const data: Uint8Array<ArrayBuffer> =
    typeof bytes === "string" ? encoder.encode(bytes) : new Uint8Array(bytes);
  return new File([data], name, { type });
}

// Read a NUL-terminated ASCII field.
function readString(buf: Uint8Array, offset: number, size: number): string {
  let end = offset;
  while (end < offset + size && buf[end] !== 0) end++;
  return decoder.decode(buf.subarray(offset, end));
}

// Parse an octal numeric field (NUL/space terminated).
function readOctal(buf: Uint8Array, offset: number, size: number): number {
  return parseInt(readString(buf, offset, size).trim() || "0", 8);
}

interface TarEntry {
  name: string;
  prefix: string;
  size: number;
  mode: number;
  typeflag: string;
  magic: string;
  checksumOk: boolean;
  data: Uint8Array;
}

// Walk a tar buffer block-by-block, returning each entry plus a flag for whether
// the stored checksum matches a freshly-computed one. Stops at the first all-zero
// header (end-of-archive marker).
function parseTar(buf: Uint8Array): { entries: TarEntry[]; trailingZeroBlocks: number } {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break; // first zero block ends the archive

    const stored = readOctal(header, 148, 8);
    // Recompute: sum all bytes with the checksum field replaced by spaces.
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) {
      sum += i >= 148 && i < 156 ? 0x20 : header[i];
    }

    const size = readOctal(header, 124, 12);
    offset += BLOCK;
    const data = buf.subarray(offset, offset + size);
    offset += Math.ceil(size / BLOCK) * BLOCK;

    entries.push({
      name: readString(header, 0, 100),
      prefix: readString(header, 345, 155),
      size,
      mode: readOctal(header, 100, 8),
      typeflag: String.fromCharCode(header[156]),
      magic: readString(header, 257, 6),
      checksumOk: sum === stored,
      data: new Uint8Array(data),
    });
  }

  // Count trailing zero blocks from `offset` to end.
  let trailingZeroBlocks = 0;
  for (let o = offset; o + BLOCK <= buf.length; o += BLOCK) {
    if (buf.subarray(o, o + BLOCK).every((b) => b === 0)) trailingZeroBlocks++;
  }
  return { entries, trailingZeroBlocks };
}

describe("createTarDescriptor", () => {
  it("bundles two in-memory files into a parseable ustar archive", async () => {
    const a = fileOf("hello.txt", "Hello, world!");
    const b = fileOf("data.bin", new Uint8Array([0, 1, 2, 3, 255, 254]));
    const files = [a, b];

    const result = await createTarDescriptor.convert({ file: files[0], files });

    expect(result.mimeType).toBe("application/x-tar");
    expect(result.filename).toBe("archive.tar");
    expect(result.inputSize).toBe(a.size + b.size);
    expect(result.outputSize).toBe(result.blob.size);

    const buf = new Uint8Array(await result.blob.arrayBuffer());
    // Total size is a multiple of 512 (every block is full-width).
    expect(buf.length % BLOCK).toBe(0);

    const { entries, trailingZeroBlocks } = parseTar(buf);
    expect(entries).toHaveLength(2);

    // Entry 0: hello.txt
    expect(entries[0].name).toBe("hello.txt");
    expect(entries[0].magic).toBe("ustar");
    expect(entries[0].typeflag).toBe("0");
    expect(entries[0].mode).toBe(0o644);
    expect(entries[0].checksumOk).toBe(true);
    expect(entries[0].size).toBe(a.size);
    expect(decoder.decode(entries[0].data)).toBe("Hello, world!");

    // Entry 1: data.bin — raw bytes preserved at the right offset.
    expect(entries[1].name).toBe("data.bin");
    expect(entries[1].checksumOk).toBe(true);
    expect(entries[1].size).toBe(b.size);
    expect(Array.from(entries[1].data)).toEqual([0, 1, 2, 3, 255, 254]);

    // Archive ends with exactly two 512-byte zero blocks.
    expect(trailingZeroBlocks).toBe(2);
  });

  it("rejects an empty file list as UNSUPPORTED_INPUT", async () => {
    await expect(
      // @ts-expect-error — deliberately constructing the no-files case the UI guards against.
      createTarDescriptor.convert({ file: undefined, files: [] }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: false });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const f = fileOf("x.txt", "x");
    await expect(
      createTarDescriptor.convert({ file: f, files: [f], signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("rejects a name too long to fit the ustar name/prefix fields", async () => {
    // A single path segment of 120 bytes has no '/' to split on and exceeds the
    // 100-byte name field → UNSUPPORTED_INPUT.
    const longName = "a".repeat(120) + ".txt";
    const f = fileOf(longName, "x");
    await expect(
      createTarDescriptor.convert({ file: f, files: [f] }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: false });
  });

  it("packs a long-but-splittable path into the name + prefix fields", async () => {
    // A path longer than 100 bytes that splits on a '/' into name ≤100 and
    // prefix ≤155 is accepted, with the two fields set so a reader rejoins them.
    const dir = "d".repeat(90);
    const base = "f".repeat(40) + ".txt";
    const path = `${dir}/${base}`; // 90 + 1 + 44 = 135 bytes total
    const f = fileOf(path, "payload");

    const result = await createTarDescriptor.convert({ file: f, files: [f] });
    const buf = new Uint8Array(await result.blob.arrayBuffer());
    const { entries } = parseTar(buf);

    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe(base);
    expect(entries[0].prefix).toBe(dir);
    expect(entries[0].checksumOk).toBe(true);
    // Rejoined path is the original.
    expect(`${entries[0].prefix}/${entries[0].name}`).toBe(path);
  });
});

describe("splitTarName", () => {
  it("returns the name unchanged when it fits the 100-byte field", () => {
    expect(splitTarName("short.txt")).toEqual({ name: "short.txt", prefix: "" });
  });

  it("splits a long path on a '/' into name + prefix", () => {
    const path = "a".repeat(90) + "/" + "b".repeat(40);
    expect(splitTarName(path)).toEqual({ name: "b".repeat(40), prefix: "a".repeat(90) });
  });

  it("returns null when a single segment exceeds 100 bytes", () => {
    expect(splitTarName("a".repeat(120))).toBeNull();
  });
});
