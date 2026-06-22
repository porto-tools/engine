import { describe, it, expect } from "vitest";
import { compressImageDescriptor } from "./compress-image";

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The compress-image pipeline runs on createImageBitmap + canvas.drawImage +
// canvas.toBlob — none of which exist in Node.
//
// TODO(test-env): wire up a browser test environment so the happy path can run
// in CI. Until then the happy path is skipped via it.skipIf.
// UNSUPPORTED_INPUT and CANCELLED both throw BEFORE any Canvas call, so they
// run for real in Node.
const canvasAvailable =
  typeof createImageBitmap === "function" && typeof document !== "undefined";

describe("compressImageDescriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(compressImageDescriptor.id).toBe("compress-image");
    expect(compressImageDescriptor.fromLabel).toBe("Image");
    expect(compressImageDescriptor.toLabel).toBe("Compressed");
    expect(compressImageDescriptor.accept).toEqual(["image/jpeg", "image/png", "image/webp"]);
    // Canvas tool: no WASM engine to download.
    expect(compressImageDescriptor.loadEngine).toBeUndefined();
    // Parameterized: mode select + quality range + targetKb number, plus the
    // A3 (pngQuantize, pngColors), A2 (grayscale, progressive, chroma), and A5
    // (autoOrient, dpi) controls.
    expect(compressImageDescriptor.controls).toHaveLength(10);
    const control = compressImageDescriptor.controls![1];
    expect(control.type).toBe("range");
    expect(control.id).toBe("quality");
    // Verify range bounds
    if (control.type === "range") {
      expect(control.min).toBe(10);
      expect(control.max).toBe(100);
      expect(control.default).toBe(80);
    }
  });

  it("exposes a mode select with quality/target options (default quality)", () => {
    const mode = compressImageDescriptor.controls!.find((c) => c.id === "mode");
    expect(mode).toBeDefined();
    expect(mode!.type).toBe("select");
    if (mode!.type === "select") {
      expect(mode!.default).toBe("quality");
      expect(mode!.options.map((o) => o.value)).toEqual(["quality", "target"]);
    }
    // defaultOptions still defaults mode to quality (the unchanged path).
    expect(compressImageDescriptor.defaultOptions).toMatchObject({ mode: "quality", quality: 80 });
  });

  it("exposes a targetKb number control with bounds", () => {
    const target = compressImageDescriptor.controls!.find((c) => c.id === "targetKb");
    expect(target).toBeDefined();
    expect(target!.type).toBe("number");
    if (target!.type === "number") {
      expect(target!.default).toBe(200);
      expect(target!.min).toBe(10);
      expect(target!.max).toBe(20000);
      expect(target!.step).toBe(10);
      expect(target!.unit).toBe("KB");
    }
    expect(compressImageDescriptor.defaultOptions).toMatchObject({ targetKb: 200 });
  });

  it("rejects unsupported input as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 0, 0, 0])], "fake.bin", {
      type: "application/octet-stream",
    });
    await expect(compressImageDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects a GIF (not in accept list) as UNSUPPORTED_INPUT", async () => {
    const file = new File(
      [new Uint8Array([0x47, 0x49, 0x46, 0x38])],
      "anim.gif",
      { type: "image/gif" },
    );
    await expect(compressImageDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], "photo.jpg", {
      type: "image/jpeg",
    });
    await expect(
      compressImageDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // TODO(test-env): needs a real browser environment with Canvas APIs.
  // Verifies that a JPEG compresses to JPEG, PNG compresses to WebP, and
  // WebP compresses to WebP at the requested quality.
  it.skipIf(!canvasAvailable)("compresses a JPEG and returns JPEG output (happy path)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const HERE = dirname(fileURLToPath(import.meta.url));
    const bytes = await readFile(join(HERE, "__fixtures__", "tiny.jpg"));
    const file = new File([bytes], "tiny.jpg", { type: "image/jpeg" });
    const result = await compressImageDescriptor.convert({
      file,
      options: { quality: 60 },
    });
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.filename).toBe("tiny.jpg");
    expect(result.outputSize).toBeGreaterThan(0);
    expect(result.inputSize).toBe(file.size);
  });

  it.skipIf(!canvasAvailable)("converts PNG input to WebP output (lossy)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const HERE = dirname(fileURLToPath(import.meta.url));
    const bytes = await readFile(join(HERE, "__fixtures__", "tiny.png"));
    const file = new File([bytes], "tiny.png", { type: "image/png" });
    const result = await compressImageDescriptor.convert({
      file,
      options: { quality: 80 },
    });
    // PNG → WebP for best lossy compression ratio
    expect(result.mimeType).toBe("image/webp");
    expect(result.filename).toBe("tiny.webp");
    expect(result.outputSize).toBeGreaterThan(0);
  });

  // TODO(test-env): needs a real browser environment with Canvas APIs.
  // Target-size mode: the binary search should produce a usable blob and keep
  // the same output MIME mapping (JPEG → JPEG).
  it.skipIf(!canvasAvailable)("target mode produces a JPEG via binary search", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const HERE = dirname(fileURLToPath(import.meta.url));
    const bytes = await readFile(join(HERE, "__fixtures__", "tiny.jpg"));
    const file = new File([bytes], "tiny.jpg", { type: "image/jpeg" });
    const result = await compressImageDescriptor.convert({
      file,
      options: { mode: "target", targetKb: 50 },
    });
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.filename).toBe("tiny.jpg");
    expect(result.outputSize).toBeGreaterThan(0);
  });

  // ── A3: PNG colour-quantization controls + defaults ──────────────────────
  it("exposes pngQuantize + pngColors controls and seeds their defaults", () => {
    const quantize = compressImageDescriptor.controls!.find((c) => c.id === "pngQuantize");
    expect(quantize).toBeDefined();
    expect(quantize!.type).toBe("checkbox");
    if (quantize!.type === "checkbox") expect(quantize!.default).toBe(false);

    const colors = compressImageDescriptor.controls!.find((c) => c.id === "pngColors");
    expect(colors).toBeDefined();
    expect(colors!.type).toBe("number");
    if (colors!.type === "number") {
      expect(colors!.default).toBe(256);
      expect(colors!.min).toBe(2);
      expect(colors!.max).toBe(256);
    }
    expect(compressImageDescriptor.defaultOptions).toMatchObject({
      pngQuantize: false,
      pngColors: 256,
    });
  });

  // ── A2: grayscale / progressive / chroma controls + defaults ─────────────
  it("exposes grayscale, progressive, and chroma controls with defaults", () => {
    const grayscale = compressImageDescriptor.controls!.find((c) => c.id === "grayscale");
    expect(grayscale).toBeDefined();
    expect(grayscale!.type).toBe("checkbox");

    const progressive = compressImageDescriptor.controls!.find((c) => c.id === "progressive");
    expect(progressive).toBeDefined();
    expect(progressive!.type).toBe("checkbox");

    const chroma = compressImageDescriptor.controls!.find((c) => c.id === "chroma");
    expect(chroma).toBeDefined();
    expect(chroma!.type).toBe("select");
    if (chroma!.type === "select") {
      expect(chroma!.default).toBe("4:2:0");
      expect(chroma!.options.map((o) => o.value)).toEqual(["4:2:0", "4:4:4"]);
    }
    expect(compressImageDescriptor.defaultOptions).toMatchObject({
      grayscale: false,
      progressive: false,
      chroma: "4:2:0",
    });
  });

  // A3 happy: PNG input + pngQuantize → palette PNG output.
  it.skipIf(!canvasAvailable)("quantizes a PNG to a palette PNG when pngQuantize is on", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const HERE = dirname(fileURLToPath(import.meta.url));
    const bytes = await readFile(join(HERE, "__fixtures__", "tiny.png"));
    const file = new File([bytes], "tiny.png", { type: "image/png" });
    const result = await compressImageDescriptor.convert({
      file,
      options: { pngQuantize: true, pngColors: 16 },
    });
    expect(result.mimeType).toBe("image/png");
    expect(result.filename).toBe("tiny.png");
    expect(result.outputSize).toBeGreaterThan(0);
  });

  // A3 default unchanged: PNG without pngQuantize still goes PNG → WebP.
  it.skipIf(!canvasAvailable)("leaves the PNG → WebP default path untouched when pngQuantize is off", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const HERE = dirname(fileURLToPath(import.meta.url));
    const bytes = await readFile(join(HERE, "__fixtures__", "tiny.png"));
    const file = new File([bytes], "tiny.png", { type: "image/png" });
    const result = await compressImageDescriptor.convert({
      file,
      options: { pngQuantize: false },
    });
    expect(result.mimeType).toBe("image/webp");
    expect(result.filename).toBe("tiny.webp");
    expect(result.outputSize).toBeGreaterThan(0);
  });

  // A3 non-PNG no-op: pngQuantize is ignored for a JPEG input.
  it.skipIf(!canvasAvailable)("ignores pngQuantize for non-PNG input", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const HERE = dirname(fileURLToPath(import.meta.url));
    const bytes = await readFile(join(HERE, "__fixtures__", "tiny.jpg"));
    const file = new File([bytes], "tiny.jpg", { type: "image/jpeg" });
    const result = await compressImageDescriptor.convert({
      file,
      options: { pngQuantize: true },
    });
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.filename).toBe("tiny.jpg");
    expect(result.outputSize).toBeGreaterThan(0);
  });

  // A2 grayscale: pure Canvas desaturation — no wasm needed, so this runs.
  it.skipIf(!canvasAvailable)("produces a valid JPEG when grayscale is on (Canvas only)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const HERE = dirname(fileURLToPath(import.meta.url));
    const bytes = await readFile(join(HERE, "__fixtures__", "tiny.jpg"));
    const file = new File([bytes], "tiny.jpg", { type: "image/jpeg" });
    const result = await compressImageDescriptor.convert({
      file,
      options: { grayscale: true },
    });
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.outputSize).toBeGreaterThan(0);
  });

  // ── A5: auto-orient + DPI controls + defaults ────────────────────────────
  it("exposes an autoOrient checkbox defaulting to true", () => {
    const autoOrient = compressImageDescriptor.controls!.find((c) => c.id === "autoOrient");
    expect(autoOrient).toBeDefined();
    expect(autoOrient!.type).toBe("checkbox");
    if (autoOrient!.type === "checkbox") expect(autoOrient!.default).toBe(true);
    expect(compressImageDescriptor.defaultOptions).toMatchObject({ autoOrient: true });
  });

  it("exposes a dpi number control (0–1200, default 0 = unchanged)", () => {
    const dpi = compressImageDescriptor.controls!.find((c) => c.id === "dpi");
    expect(dpi).toBeDefined();
    expect(dpi!.type).toBe("number");
    if (dpi!.type === "number") {
      expect(dpi!.default).toBe(0);
      expect(dpi!.min).toBe(0);
      expect(dpi!.max).toBe(1200);
      expect(dpi!.step).toBe(1);
      expect(dpi!.unit).toBe("DPI");
    }
    expect(compressImageDescriptor.defaultOptions).toMatchObject({ dpi: 0 });
  });

  // A5 happy auto-orient: a JPEG with autoOrient on still produces valid JPEG.
  it.skipIf(!canvasAvailable)("produces a valid JPEG with auto-orient on (default)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const HERE = dirname(fileURLToPath(import.meta.url));
    const bytes = await readFile(join(HERE, "__fixtures__", "tiny.jpg"));
    const file = new File([bytes], "tiny.jpg", { type: "image/jpeg" });
    const result = await compressImageDescriptor.convert({
      file,
      options: { quality: 80, autoOrient: true },
    });
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.outputSize).toBeGreaterThan(0);
  });

  // A5 DPI applied: the JFIF density bytes of the JPEG output carry the DPI.
  it.skipIf(!canvasAvailable)("stamps the DPI into the JFIF APP0 of the JPEG output", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const HERE = dirname(fileURLToPath(import.meta.url));
    const bytes = await readFile(join(HERE, "__fixtures__", "tiny.jpg"));
    const file = new File([bytes], "tiny.jpg", { type: "image/jpeg" });
    const result = await compressImageDescriptor.convert({
      file,
      options: { quality: 80, dpi: 300 },
    });
    expect(result.mimeType).toBe("image/jpeg");
    const out = new Uint8Array(await result.blob.arrayBuffer());
    // JFIF density unit byte (offset 13) = 1, X/Y density (14-17) = 300 big-endian.
    expect(out[13]).toBe(1);
    expect((out[14] << 8) | out[15]).toBe(300);
    expect((out[16] << 8) | out[17]).toBe(300);
  });

  // A5 DPI on the MozJPEG (progressive) path: the patch must apply to the wasm
  // encoder's JPEG output too, not just the Canvas toBlob output.
  it.skipIf(!canvasAvailable)("stamps the DPI into the progressive (MozJPEG) JPEG output", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const HERE = dirname(fileURLToPath(import.meta.url));
    const bytes = await readFile(join(HERE, "__fixtures__", "tiny.jpg"));
    const file = new File([bytes], "tiny.jpg", { type: "image/jpeg" });
    const result = await compressImageDescriptor.convert({
      file,
      options: { quality: 80, progressive: true, dpi: 150 },
    });
    expect(result.mimeType).toBe("image/jpeg");
    const out = new Uint8Array(await result.blob.arrayBuffer());
    expect(out[13]).toBe(1);
    expect((out[14] << 8) | out[15]).toBe(150);
    expect((out[16] << 8) | out[17]).toBe(150);
  });

  // A5 DPI=0 no-op: the default output is byte-identical to a no-dpi-option run.
  it.skipIf(!canvasAvailable)("leaves the JPEG bytes unchanged when dpi is 0 (byte-identical default)", async () => {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const HERE = dirname(fileURLToPath(import.meta.url));
    const bytes = await readFile(join(HERE, "__fixtures__", "tiny.jpg"));
    const file = new File([bytes], "tiny.jpg", { type: "image/jpeg" });
    const withZero = await compressImageDescriptor.convert({
      file,
      options: { quality: 80, dpi: 0 },
    });
    const withoutOption = await compressImageDescriptor.convert({
      file,
      options: { quality: 80 },
    });
    const a = new Uint8Array(await withZero.blob.arrayBuffer());
    const b = new Uint8Array(await withoutOption.blob.arrayBuffer());
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
