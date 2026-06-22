// Tests for image-to-ico. Happy path (canvas + blob) is guarded by
// canvasAvailable. UNSUPPORTED_INPUT, CANCELLED, parseSizes, and buildIco are
// tested unconditionally (no DOM required).
//
// TODO(test-env): remove the skipIf guard once a browser/canvas environment is
// available in CI.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  imageToIcoDescriptor,
  parseSizes,
  buildIco,
  SUPPORTED_ICO_SIZES,
  DEFAULT_ICO_SIZES,
} from "./image-to-ico";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, "__fixtures__", name);

async function fileFromFixture(name: string, mime: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: mime });
}

const canvasAvailable =
  typeof createImageBitmap === "function" && typeof document !== "undefined";

describe("imageToIcoDescriptor", () => {
  it("declares the descriptor fields", () => {
    expect(imageToIcoDescriptor.id).toBe("image-to-ico");
    expect(imageToIcoDescriptor.newExtension).toBe("ico");
    expect(imageToIcoDescriptor.toLabel).toBe("ICO");
    // The on-page tool renders its own size checkboxes + preview, so the
    // descriptor declares NO shared ControlPanel controls. It still seeds the
    // default size selection via defaultOptions.
    expect(imageToIcoDescriptor.controls).toBeUndefined();
    expect(imageToIcoDescriptor.defaultOptions?.icoSizes).toBe(DEFAULT_ICO_SIZES.join(","));
    // Pure Canvas conversion — no WASM engine to load.
    expect(imageToIcoDescriptor.loadEngine).toBeUndefined();
  });

  // TODO(test-env): run in browser/canvas env.
  it.skipIf(!canvasAvailable)("converts the happy path to a valid ICO", async () => {
    const file = await fileFromFixture("tiny.png", "image/png");
    const result = await imageToIcoDescriptor.convert({
      file,
      options: { icoSizes: "16,32" },
    });
    expect(result.mimeType).toBe("image/x-icon");
    expect(result.filename).toBe("tiny.ico");
    expect(result.outputSize).toBeGreaterThan(0);
    // ICO files start with the 4-byte magic: 00 00 01 00
    const buf = await result.blob.arrayBuffer();
    const view = new DataView(buf);
    expect(view.getUint16(0, true)).toBe(0); // reserved
    expect(view.getUint16(2, true)).toBe(1); // type = icon
  });

  it("rejects unsupported input as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 0, 0, 0])], "fake.bin", {
      type: "application/octet-stream",
    });
    await expect(imageToIcoDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("tiny.png", "image/png");
    await expect(
      imageToIcoDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });
});

describe("parseSizes", () => {
  it("parses the default '16,32,48'", () => {
    expect(parseSizes("16,32,48")).toEqual([16, 32, 48]);
  });

  it("parses a single size", () => {
    expect(parseSizes("32")).toEqual([32]);
  });

  it("deduplicates and sorts", () => {
    expect(parseSizes("48,16,32,16")).toEqual([16, 32, 48]);
  });

  it("accepts the newly supported 24px size", () => {
    expect(parseSizes("24,48")).toEqual([24, 48]);
  });

  it("filters out non-standard sizes (only the supported set passes)", () => {
    // 0, 17, 100, 257, 512 are not standard ICO sizes → dropped.
    expect(parseSizes("0,16,17,100,257,512")).toEqual([16]);
  });

  it("defaults to the favicon set for empty or invalid input", () => {
    const def = [...DEFAULT_ICO_SIZES];
    expect(parseSizes("")).toEqual(def);
    expect(parseSizes(undefined)).toEqual(def);
    expect(parseSizes("abc")).toEqual(def);
    // A string of only-unsupported sizes also falls back to the default.
    expect(parseSizes("512,999")).toEqual(def);
  });

  it("accepts the full supported set", () => {
    expect(parseSizes(SUPPORTED_ICO_SIZES.join(","))).toEqual([...SUPPORTED_ICO_SIZES]);
  });
});

describe("SUPPORTED_ICO_SIZES", () => {
  it("is the standard multi-resolution set up to 256", () => {
    expect([...SUPPORTED_ICO_SIZES]).toEqual([16, 24, 32, 48, 64, 128, 256]);
  });

  it("includes 256 (the largest size the ICO format addresses)", () => {
    expect(SUPPORTED_ICO_SIZES).toContain(256);
  });

  it("default selection is a subset of the supported sizes", () => {
    for (const s of DEFAULT_ICO_SIZES) {
      expect(SUPPORTED_ICO_SIZES).toContain(s);
    }
  });
});

describe("buildIco", () => {
  // Build a minimal ICO with a synthetic single-pixel PNG substitute (just
  // some bytes — we only check the directory structure, not that the payload
  // is valid PNG).
  const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]); // 6 bytes

  it("produces the correct ICONDIR header for one frame", () => {
    const ico = buildIco([{ size: 16, png: FAKE_PNG }]);
    const view = new DataView(ico.buffer);
    expect(view.getUint16(0, true)).toBe(0); // reserved
    expect(view.getUint16(2, true)).toBe(1); // type = 1 (icon)
    expect(view.getUint16(4, true)).toBe(1); // count = 1
  });

  it("produces the correct ICONDIRENTRY for 16×16", () => {
    const ico = buildIco([{ size: 16, png: FAKE_PNG }]);
    // ICONDIR (6) + ICONDIRENTRY starts at offset 6
    expect(ico[6]).toBe(16); // width
    expect(ico[7]).toBe(16); // height
    expect(ico[8]).toBe(0); // colorCount
    expect(ico[9]).toBe(0); // reserved
    const view = new DataView(ico.buffer);
    expect(view.getUint16(10, true)).toBe(1); // planes
    expect(view.getUint16(12, true)).toBe(32); // bitCount
    expect(view.getUint32(14, true)).toBe(FAKE_PNG.byteLength); // bytesInRes
    // imageOffset = 6 (ICONDIR) + 16 (one ICONDIRENTRY) = 22
    expect(view.getUint32(18, true)).toBe(22);
  });

  it("encodes 256 as 0 in width/height fields", () => {
    const ico = buildIco([{ size: 256, png: FAKE_PNG }]);
    expect(ico[6]).toBe(0); // 256 → 0 per spec
    expect(ico[7]).toBe(0);
  });

  it("places PNG payload at the correct offset for two frames", () => {
    const PNG_A = new Uint8Array([0x01, 0x02, 0x03]);
    const PNG_B = new Uint8Array([0x04, 0x05]);
    const ico = buildIco([
      { size: 16, png: PNG_A },
      { size: 32, png: PNG_B },
    ]);
    // Directory: 6 + 2×16 = 38. First payload at offset 38.
    const dataStart = 6 + 2 * 16;
    expect(ico[dataStart + 0]).toBe(0x01);
    expect(ico[dataStart + 1]).toBe(0x02);
    expect(ico[dataStart + 2]).toBe(0x03);
    // Second payload immediately after.
    expect(ico[dataStart + 3]).toBe(0x04);
    expect(ico[dataStart + 4]).toBe(0x05);
  });

  it("total byte length equals header + entries + all payload bytes", () => {
    const FRAME_COUNT = 3;
    const pngs = [
      new Uint8Array(100),
      new Uint8Array(200),
      new Uint8Array(50),
    ];
    const frames = pngs.map((png, i) => ({ size: [16, 32, 48][i], png }));
    const ico = buildIco(frames);
    const expected = 6 + FRAME_COUNT * 16 + 100 + 200 + 50;
    expect(ico.byteLength).toBe(expected);
  });

  // Full multi-resolution container check on a tiny synthetic input: validate
  // the whole ICONDIR + every ICONDIRENTRY for a 16/32/48/256 icon, including
  // that the 256 entry encodes its dimensions as 0, that planes/bitCount carry
  // the 32-bpp (alpha-preserving) values, and that every payload offset+length
  // points inside the file and the regions tile without gaps.
  it("emits a well-formed directory for a 16/32/48/256 multi-size ICO", () => {
    const sizes = [16, 32, 48, 256];
    // Distinct payload lengths so a swapped offset/length would be caught.
    const frames = sizes.map((size, i) => ({ size, png: new Uint8Array(8 + i * 3).fill(i + 1) }));
    const ico = buildIco(frames);
    const view = new DataView(ico.buffer);

    // ICONDIR
    expect(view.getUint16(0, true)).toBe(0); // reserved
    expect(view.getUint16(2, true)).toBe(1); // type = icon
    expect(view.getUint16(4, true)).toBe(sizes.length); // count

    const dirEnd = 6 + sizes.length * 16;
    let runningOffset = dirEnd; // payloads start right after the directory
    for (let i = 0; i < sizes.length; i++) {
      const base = 6 + i * 16;
      const size = sizes[i];
      const expectedDim = size === 256 ? 0 : size;
      expect(ico[base + 0]).toBe(expectedDim); // width
      expect(ico[base + 1]).toBe(expectedDim); // height
      expect(ico[base + 2]).toBe(0); // colorCount
      expect(ico[base + 3]).toBe(0); // reserved
      expect(view.getUint16(base + 4, true)).toBe(1); // planes
      expect(view.getUint16(base + 6, true)).toBe(32); // bitCount (RGBA)

      const bytesInRes = view.getUint32(base + 8, true);
      const imageOffset = view.getUint32(base + 12, true);
      expect(bytesInRes).toBe(frames[i].png.byteLength);
      // Payloads tile contiguously starting at dirEnd, in order.
      expect(imageOffset).toBe(runningOffset);
      // Region stays within the file.
      expect(imageOffset + bytesInRes).toBeLessThanOrEqual(ico.byteLength);
      runningOffset += bytesInRes;
    }
    // The last region ends exactly at end-of-file (no trailing slack).
    expect(runningOffset).toBe(ico.byteLength);
  });

  // End-to-end container check with REAL PNG bytes (the tiny.png fixture) as the
  // payloads: every directory entry must point at a region that begins with the
  // 8-byte PNG signature and lies fully inside the file. This is the property a
  // real OS/browser ICO parser relies on, exercised without needing a canvas.
  it("points each directory entry at a region starting with the PNG signature", async () => {
    const png = new Uint8Array(await readFile(fixturePath("tiny.png")));
    const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const sizes = parseSizes("16,32,256");
    const ico = buildIco(sizes.map((size) => ({ size, png })));
    const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);

    const count = view.getUint16(4, true);
    expect(count).toBe(sizes.length);
    for (let i = 0; i < count; i++) {
      const base = 6 + i * 16;
      const bytesInRes = view.getUint32(base + 8, true);
      const imageOffset = view.getUint32(base + 12, true);
      expect(bytesInRes).toBe(png.byteLength);
      expect(imageOffset + bytesInRes).toBeLessThanOrEqual(ico.byteLength);
      const sig = Array.from(ico.subarray(imageOffset, imageOffset + 8));
      expect(sig).toEqual(PNG_SIG);
    }
  });
});
