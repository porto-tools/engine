// Tests for dpi-patch — the pure byte-level DPI metadata writers shared by the
// three image tools (image-converter, compress-image, image-resize). These are
// plain ArrayBuffer/Uint8Array functions with NO DOM and NO canvas, so they run
// for real in the default Node test environment (unlike the canvas happy paths,
// which are skipped). That makes this file the load-bearing coverage for the
// byte-level math the orchestrator will review.

import { describe, it, expect } from "vitest";
import { clampDpi, patchJfifDpi, patchPngPhys, MAX_DPI } from "./dpi-patch";

// A minimal valid JFIF JPEG: SOI + APP0("JFIF\0", version 1.1, unit 0, density
// 1×1, no thumbnail) + EOI. This mirrors the real canvas/MozJPEG JPEG layout,
// where the APP0 segment is the first marker after SOI.
function makeJfifJpeg(): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8, // SOI
    0xff, 0xe0, // APP0
    0x00, 0x10, // length = 16
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01, // version 1.1
    0x00, // density unit = 0 (no units)
    0x00, 0x01, // Xdensity = 1
    0x00, 0x01, // Ydensity = 1
    0x00, // Xthumbnail
    0x00, // Ythumbnail
    0xff, 0xd9, // EOI
  ]);
}

// A minimal valid PNG: 8-byte signature + IHDR(13 data bytes) + IEND. Enough to
// exercise pHYs insertion (which must land immediately after IHDR).
function makePng(): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  // IHDR: length(4) + "IHDR"(4) + 13 data bytes + CRC(4) = 25 bytes
  const ihdr = [
    0x00, 0x00, 0x00, 0x0d, // length = 13
    0x49, 0x48, 0x44, 0x52, // "IHDR"
    0x00, 0x00, 0x00, 0x01, // width = 1
    0x00, 0x00, 0x00, 0x01, // height = 1
    0x08, 0x06, 0x00, 0x00, 0x00, // bit depth, colour, compression, filter, interlace
    0x1f, 0x15, 0xc4, 0x89, // IHDR CRC (real value for this 1×1 RGBA header)
  ];
  // IEND: length 0 + "IEND" + CRC
  const iend = [0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  return new Uint8Array([...sig, ...ihdr, ...iend]);
}

// Read a big-endian uint32 at offset.
function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

describe("clampDpi", () => {
  it("passes an in-range integer through unchanged", () => {
    expect(clampDpi(300)).toBe(300);
    expect(clampDpi(72)).toBe(72);
  });

  it("treats 0 as the unchanged sentinel and keeps it", () => {
    expect(clampDpi(0)).toBe(0);
  });

  it("clamps a negative value up to 0", () => {
    expect(clampDpi(-50)).toBe(0);
  });

  it("clamps above the maximum down to MAX_DPI", () => {
    expect(clampDpi(99999)).toBe(MAX_DPI);
    expect(MAX_DPI).toBe(1200);
  });

  it("rounds and parses numeric strings", () => {
    expect(clampDpi("149.6")).toBe(150);
  });

  it("falls back to 0 (unchanged) for non-numeric or missing values", () => {
    expect(clampDpi("abc")).toBe(0);
    expect(clampDpi(undefined)).toBe(0);
    expect(clampDpi(NaN)).toBe(0);
  });
});

describe("patchJfifDpi", () => {
  it("sets the JFIF density unit byte to 1 (dots per inch) and X/Y density big-endian", () => {
    const out = patchJfifDpi(makeJfifJpeg(), 300);
    // APP0 payload: SOI(2) + marker(2) + length(2) + "JFIF\0"(5) + version(2),
    // so the density-unit byte is at offset 13, then X density (14-15) and Y
    // density (16-17), all big-endian.
    expect(out[13]).toBe(1); // unit = 1 → DPI
    expect(out[14]).toBe((300 >> 8) & 0xff);
    expect(out[15]).toBe(300 & 0xff);
    expect(out[16]).toBe((300 >> 8) & 0xff);
    expect(out[17]).toBe(300 & 0xff);
  });

  it("writes a density above 255 as two big-endian bytes", () => {
    const out = patchJfifDpi(makeJfifJpeg(), 600);
    expect(out[14]).toBe(0x02); // 600 = 0x0258
    expect(out[15]).toBe(0x58);
    expect(out[16]).toBe(0x02);
    expect(out[17]).toBe(0x58);
  });

  it("does not change the byte length (it patches in place)", () => {
    const input = makeJfifJpeg();
    const out = patchJfifDpi(input, 300);
    expect(out.length).toBe(input.length);
  });

  it("leaves the SOI and APP0 markers intact", () => {
    const out = patchJfifDpi(makeJfifJpeg(), 300);
    expect([out[0], out[1]]).toEqual([0xff, 0xd8]); // SOI
    expect([out[2], out[3]]).toEqual([0xff, 0xe0]); // APP0
    expect([out[6], out[7], out[8], out[9], out[10]]).toEqual([0x4a, 0x46, 0x49, 0x46, 0x00]);
  });

  it("returns the bytes unchanged when there is no JFIF APP0 segment", () => {
    // A JPEG that opens with an EXIF APP1 instead of a JFIF APP0 — nothing to patch.
    const noJfif = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x04, 0x00, 0x00, 0xff, 0xd9]);
    const out = patchJfifDpi(noJfif, 300);
    expect(Array.from(out)).toEqual(Array.from(noJfif));
  });
});

describe("patchPngPhys", () => {
  it("inserts a pHYs chunk immediately after IHDR with the correct ppu and unit", () => {
    const out = patchPngPhys(makePng(), 300);
    // 300 DPI → pixels-per-metre = round(300 * 39.3701) = 11811.
    const expectedPpu = Math.round(300 * 39.3701); // 11811
    // After the 8-byte signature, IHDR occupies 25 bytes (len4 + "IHDR"4 + 13 + crc4).
    // The pHYs chunk must begin at offset 8 + 25 = 33.
    const physStart = 8 + 25;
    // Chunk length (data) = 9 bytes.
    expect(readU32(out, physStart)).toBe(9);
    // Chunk type "pHYs".
    expect([
      out[physStart + 4],
      out[physStart + 5],
      out[physStart + 6],
      out[physStart + 7],
    ]).toEqual([0x70, 0x48, 0x59, 0x73]);
    // X ppu (big-endian uint32) at data offset.
    const dataStart = physStart + 8;
    expect(readU32(out, dataStart)).toBe(expectedPpu);
    expect(readU32(out, dataStart + 4)).toBe(expectedPpu);
    // Unit specifier byte = 1 (metre).
    expect(out[dataStart + 8]).toBe(1);
  });

  it("writes a CRC over the chunk type + data that a fresh CRC32 verifies", () => {
    const out = patchPngPhys(makePng(), 300);
    const physStart = 8 + 25;
    const length = readU32(out, physStart);
    // CRC covers the 4 type bytes + `length` data bytes (per the PNG spec).
    const crcInputStart = physStart + 4;
    const crcInput = out.slice(crcInputStart, crcInputStart + 4 + length);
    const storedCrc = readU32(out, crcInputStart + 4 + length);
    // Independent reference CRC32 (standard PNG polynomial) computed in the test.
    expect(referenceCrc32(crcInput)).toBe(storedCrc);
  });

  it("grows the file by exactly the pHYs chunk size (12 + 9 = 21 bytes)", () => {
    const input = makePng();
    const out = patchPngPhys(input, 300);
    // pHYs chunk = length(4) + type(4) + data(9) + crc(4) = 21 bytes.
    expect(out.length).toBe(input.length + 21);
  });

  it("preserves the PNG signature and the original IHDR and IEND", () => {
    const input = makePng();
    const out = patchPngPhys(input, 300);
    // Signature unchanged.
    expect(Array.from(out.slice(0, 8))).toEqual(Array.from(input.slice(0, 8)));
    // IHDR (signature + 25 bytes) unchanged.
    expect(Array.from(out.slice(8, 8 + 25))).toEqual(Array.from(input.slice(8, 8 + 25)));
    // IEND still present at the very end (last 12 bytes).
    expect(Array.from(out.slice(out.length - 12))).toEqual(Array.from(input.slice(input.length - 12)));
  });

  it("replaces an existing pHYs chunk rather than inserting a duplicate", () => {
    // First patch inserts a pHYs; a second patch at a different DPI must update
    // it in place (still exactly one pHYs chunk).
    const once = patchPngPhys(makePng(), 72);
    const twice = patchPngPhys(once, 300);
    // Same total length both times (no duplicate chunk).
    expect(twice.length).toBe(once.length);
    const physStart = 8 + 25;
    const dataStart = physStart + 8;
    expect(readU32(twice, dataStart)).toBe(Math.round(300 * 39.3701));
  });

  it("returns the bytes unchanged when there is no IHDR (not a PNG)", () => {
    const notPng = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
    const out = patchPngPhys(notPng, 300);
    expect(Array.from(out)).toEqual(Array.from(notPng));
  });
});

// A self-contained reference CRC32 (standard PNG/zlib polynomial 0xEDB88320),
// used only to independently verify patchPngPhys's stored CRC in the tests.
function referenceCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
