// Tests for image-converter, the universal MANY-OUT image converter. The happy
// path runs on createImageBitmap + canvas.toBlob, which don't exist in the
// default Node test environment, so it is guarded by `it.skipIf(!canvasAvailable)`
// exactly like image-resize / image-to-ico (TODO(test-env): auto-runs once a
// browser/canvas env exists in CI). The conversion's real selection/clamp LOGIC —
// which formats are ticked, quality clamping, background validation — is extracted
// into the pure `selectedFormats` / `clampQuality` / `readBackground` helpers and
// unit-tested below with full coverage and zero new dependency. UNSUPPORTED_INPUT
// (wrong MIME and zero-formats) and CANCELLED throw before any Canvas call, so
// they run in Node unconditionally.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  imageConverterDescriptor,
  selectedFormats,
  clampQuality,
  readBackground,
  OUTPUT_FORMATS,
} from "./image-converter";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, "__fixtures__", name);

async function fileFromFixture(name: string, mime: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: mime });
}

const canvasAvailable =
  typeof createImageBitmap === "function" && typeof document !== "undefined";

describe("imageConverterDescriptor", () => {
  it("declares the multi-output, controls-driven, Canvas descriptor", () => {
    expect(imageConverterDescriptor.id).toBe("image-converter");
    expect(imageConverterDescriptor.outputMode).toBe("multi");
    // Pure Canvas conversion — no WASM engine to download.
    expect(imageConverterDescriptor.loadEngine).toBeUndefined();
    // The canvas-decodable raster input set (HEIC/SVG/AVIF input are a follow-up).
    expect(imageConverterDescriptor.accept).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "image/bmp",
    ]);
  });

  it("offers a format toggle-group with PNG/JPG/WEBP/BMP and PNG ticked by default", () => {
    const formats = imageConverterDescriptor.controls!.find((c) => c.id === "formats");
    expect(formats?.type).toBe("toggle-group");
    if (formats?.type === "toggle-group") {
      expect(formats.toggles.map((t) => t.id)).toEqual(["PNG", "JPG", "WEBP", "BMP"]);
    }
    // PNG ticked by default so a Convert click always yields at least one file.
    expect(imageConverterDescriptor.defaultOptions?.formatsPNG).toBe(true);
    expect(imageConverterDescriptor.defaultOptions?.formatsJPG).toBe(false);
  });

  it("declares a quality range control (10–100, default 92)", () => {
    const quality = imageConverterDescriptor.controls!.find((c) => c.id === "quality");
    expect(quality?.type).toBe("range");
    if (quality?.type === "range") {
      expect(quality.min).toBe(10);
      expect(quality.max).toBe(100);
      expect(quality.default).toBe(92);
    }
  });

  it("declares a background select (white default) for JPG fills", () => {
    const bg = imageConverterDescriptor.controls!.find((c) => c.id === "background");
    expect(bg?.type).toBe("select");
    if (bg?.type === "select") {
      expect(bg.default).toBe("white");
      expect(bg.options.map((o) => o.value)).toEqual(["white", "black"]);
    }
  });

  // ── Happy path (needs a real browser to decode + re-encode) ────────────────

  it.skipIf(!canvasAvailable)(
    "returns one output per ticked format with the right mimeTypes, extensions, and non-zero sizes",
    async () => {
      const file = await fileFromFixture("tiny.png", "image/png");
      const result = await imageConverterDescriptor.convert({
        file,
        options: { formatsPNG: true, formatsJPG: true, formatsWEBP: true },
      });
      // Three formats ticked → three outputs, in OUTPUT_FORMATS order.
      expect(result.outputs).toBeDefined();
      expect(result.outputs!.length).toBe(3);
      expect(result.outputs!.map((o) => o.mimeType)).toEqual([
        "image/png",
        "image/jpeg",
        "image/webp",
      ]);
      expect(result.outputs!.map((o) => o.filename)).toEqual([
        "tiny.png",
        "tiny.jpg",
        "tiny.webp",
      ]);
      for (const out of result.outputs!) {
        expect(out.size).toBeGreaterThan(0);
      }
      // Representative single fields point at the first output; outputSize sums all.
      expect(result.filename).toBe("tiny.png");
      expect(result.mimeType).toBe("image/png");
      expect(result.outputSize).toBe(result.outputs!.reduce((s, o) => s + o.size, 0));
    },
  );

  it.skipIf(!canvasAvailable)(
    "produces a single output when only one format is ticked",
    async () => {
      const file = await fileFromFixture("tiny.png", "image/png");
      const result = await imageConverterDescriptor.convert({
        file,
        options: { formatsWEBP: true },
      });
      expect(result.outputs!.length).toBe(1);
      expect(result.outputs![0].mimeType).toBe("image/webp");
      expect(result.outputs![0].filename).toBe("tiny.webp");
    },
  );

  // ── Error paths (run in Node, no canvas needed) ────────────────────────────

  it("rejects with a recoverable UNSUPPORTED_INPUT when zero formats are selected", async () => {
    const file = await fileFromFixture("tiny.png", "image/png");
    await expect(
      // Every format key explicitly off.
      imageConverterDescriptor.convert({
        file,
        options: { formatsPNG: false, formatsJPG: false, formatsWEBP: false, formatsBMP: false },
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: true });
  });

  it("rejects with a recoverable UNSUPPORTED_INPUT when no format options are passed at all", async () => {
    const file = await fileFromFixture("tiny.png", "image/png");
    // No options object → no format ticked → the same recoverable nudge.
    await expect(imageConverterDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: true,
    });
  });

  it("rejects the wrong MIME as a non-recoverable UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 0, 0, 0])], "fake.bin", {
      type: "application/octet-stream",
    });
    await expect(
      imageConverterDescriptor.convert({ file, options: { formatsPNG: true } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: false });
  });

  it("respects an already-aborted signal as CANCELLED before doing any work", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("tiny.png", "image/png");
    await expect(
      imageConverterDescriptor.convert({ file, signal: ctrl.signal, options: { formatsPNG: true } }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // ── A5: auto-orient + DPI controls + defaults ────────────────────────────
  it("declares an autoOrient checkbox defaulting to true", () => {
    const autoOrient = imageConverterDescriptor.controls!.find((c) => c.id === "autoOrient");
    expect(autoOrient?.type).toBe("checkbox");
    if (autoOrient?.type === "checkbox") expect(autoOrient.default).toBe(true);
    expect(imageConverterDescriptor.defaultOptions?.autoOrient).toBe(true);
  });

  it("declares a dpi number control (0–1200, default 0 = unchanged)", () => {
    const dpi = imageConverterDescriptor.controls!.find((c) => c.id === "dpi");
    expect(dpi?.type).toBe("number");
    if (dpi?.type === "number") {
      expect(dpi.default).toBe(0);
      expect(dpi.min).toBe(0);
      expect(dpi.max).toBe(1200);
      expect(dpi.unit).toBe("DPI");
    }
    expect(imageConverterDescriptor.defaultOptions?.dpi).toBe(0);
  });

  // A5 happy auto-orient: a PNG → PNG conversion with auto-orient on (default).
  it.skipIf(!canvasAvailable)("converts with auto-orient on (default) producing valid outputs", async () => {
    const file = await fileFromFixture("tiny.png", "image/png");
    const result = await imageConverterDescriptor.convert({
      file,
      options: { formatsPNG: true, formatsJPG: true, autoOrient: true },
    });
    expect(result.outputs!.length).toBe(2);
    for (const out of result.outputs!) expect(out.size).toBeGreaterThan(0);
  });

  // A5 DPI applied: the JPG output's JFIF density bytes carry the DPI, and the
  // PNG output gains a pHYs chunk; the WebP output is left untouched (no DPI tag).
  it.skipIf(!canvasAvailable)("stamps the DPI into JPG (JFIF) and PNG (pHYs) outputs, skipping WebP", async () => {
    const file = await fileFromFixture("tiny.png", "image/png");
    const result = await imageConverterDescriptor.convert({
      file,
      options: { formatsPNG: true, formatsJPG: true, formatsWEBP: true, dpi: 300 },
    });
    const byMime = Object.fromEntries(
      await Promise.all(
        result.outputs!.map(async (o) => [o.mimeType, new Uint8Array(await o.blob.arrayBuffer())] as const),
      ),
    );
    // JPG: JFIF density unit + density bytes.
    const jpg = byMime["image/jpeg"];
    expect(jpg[13]).toBe(1);
    expect((jpg[14] << 8) | jpg[15]).toBe(300);
    // PNG: a pHYs chunk is present.
    expect(containsBytes(byMime["image/png"], [0x70, 0x48, 0x59, 0x73])).toBe(true);
    // WebP: no DPI mechanism, so it must NOT contain a JFIF/pHYs marker we wrote.
    expect(containsBytes(byMime["image/webp"], [0x70, 0x48, 0x59, 0x73])).toBe(false);
  });

  // A5 DPI=0 no-op: the default output is byte-identical to a no-dpi-option run.
  it.skipIf(!canvasAvailable)("leaves outputs unchanged when dpi is 0 (byte-identical default)", async () => {
    const file = await fileFromFixture("tiny.png", "image/png");
    const opts = { formatsPNG: true, formatsJPG: true };
    const withZero = await imageConverterDescriptor.convert({ file, options: { ...opts, dpi: 0 } });
    const withoutOption = await imageConverterDescriptor.convert({ file, options: opts });
    for (let i = 0; i < withZero.outputs!.length; i++) {
      const a = new Uint8Array(await withZero.outputs![i].blob.arrayBuffer());
      const b = new Uint8Array(await withoutOption.outputs![i].blob.arrayBuffer());
      expect(Array.from(a)).toEqual(Array.from(b));
    }
  });
});

// Tiny helper: does `haystack` contain the contiguous byte sequence `needle`?
function containsBytes(haystack: Uint8Array, needle: number[]): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

// The format selection + clamp logic is pure (no DOM), so it gets full unit
// coverage here independent of a canvas.
describe("selectedFormats", () => {
  it("returns only the ticked formats, in OUTPUT_FORMATS order regardless of key order", () => {
    const sel = selectedFormats({ formatsWEBP: true, formatsPNG: true });
    expect(sel.map((f) => f.id)).toEqual(["PNG", "WEBP"]);
  });

  it("treats only the strict boolean true as on (string/number/undefined are off)", () => {
    const sel = selectedFormats({
      formatsPNG: true,
      formatsJPG: "true" as unknown as boolean,
      formatsWEBP: 1 as unknown as boolean,
      formatsBMP: undefined,
    });
    expect(sel.map((f) => f.id)).toEqual(["PNG"]);
  });

  it("returns an empty list when nothing is ticked or options are absent", () => {
    expect(selectedFormats({})).toEqual([]);
    expect(selectedFormats(undefined)).toEqual([]);
    expect(selectedFormats({ formatsPNG: false })).toEqual([]);
  });

  it("can select every format at once", () => {
    const sel = selectedFormats({
      formatsPNG: true,
      formatsJPG: true,
      formatsWEBP: true,
      formatsBMP: true,
    });
    expect(sel.map((f) => f.id)).toEqual(OUTPUT_FORMATS.map((f) => f.id));
  });
});

describe("clampQuality", () => {
  it("passes through an in-range value", () => {
    expect(clampQuality(80)).toBe(80);
  });

  it("clamps below 10 and above 100", () => {
    expect(clampQuality(0)).toBe(10);
    expect(clampQuality(250)).toBe(100);
  });

  it("rounds and parses numeric strings", () => {
    expect(clampQuality("73.6")).toBe(74);
  });

  it("falls back to the default (92) for non-numeric or missing values", () => {
    expect(clampQuality("abc")).toBe(92);
    expect(clampQuality(undefined)).toBe(92);
    expect(clampQuality(NaN)).toBe(92);
  });
});

describe("readBackground", () => {
  it("maps the known keys to their hex colours", () => {
    expect(readBackground("white")).toBe("#ffffff");
    expect(readBackground("black")).toBe("#000000");
  });

  it("falls back to white for unknown or non-string values (no arbitrary CSS injection)", () => {
    expect(readBackground("rebeccapurple")).toBe("#ffffff");
    expect(readBackground(undefined)).toBe("#ffffff");
    expect(readBackground(42)).toBe("#ffffff");
  });
});
