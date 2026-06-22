// Tests for the Repair PDF conversion.
//
// porto-tools' vitest.config.ts uses the default Node environment. qpdf-wasm is
// an Emscripten WASM build that fetches its companion .wasm via a browser
// locateFile and cannot run in Node, so the real repair round-trip is exercised
// by the engine in the browser, not here. We mock the shared ./qpdf module the
// same way the protect-pdf / unlock-pdf / compress-pdf tests do: a hoisted
// recorder captures the argv the descriptor builds (by invoking its buildArgs
// callback with the real in/out paths) and lets each test pick the run result.
//
// That lets us assert the full convert() contract in Node:
//   - happy path: a valid PDF "repairs" → correct mimeType, -repaired filename,
//     non-zero outputSize, %PDF header
//   - the exact repair argv, with and without linearize
//   - UNSUPPORTED_INPUT (wrong MIME), DECODE_FAILED (qpdf fails on garbage),
//     CANCELLED (pre-aborted signal)
//   - the linearize control defaults OFF
//
// The pure helpers (wantsLinearize, buildRepairArgs) are DOM-free and get full
// unit coverage independent of the wasm engine.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// A hoisted recorder for the mocked qpdf run. `result` is the bytes+exitCode the
// fake runQpdf returns; `lastArgs` is the argv the descriptor built for this run.
const qpdfMock = vi.hoisted(() => ({
  calls: 0,
  lastArgs: null as string[] | null,
  // A "successful" repair: a minimal valid PDF byte sequence. Tests that need a
  // failure (garbage in → qpdf can't recover) override this.
  result: { data: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]), exitCode: 0 },
}));

vi.mock("./qpdf", () => ({
  loadQpdf: vi.fn(async () => () => {}),
  runQpdf: vi.fn(async (_file: File, buildArgs: (i: string, o: string) => string[]) => {
    qpdfMock.calls += 1;
    qpdfMock.lastArgs = buildArgs("/in/input.pdf", "/out/output.pdf");
    return qpdfMock.result;
  }),
}));

import { repairPdfDescriptor, wantsLinearize, buildRepairArgs } from "./repair-pdf";

// Reuse the shared tiny single-page PDF fixture (committed under flatten-pdf).
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "__fixtures__", "flatten-pdf", "tiny.pdf");

async function tinyPdfFile(): Promise<File> {
  const bytes = await readFile(FIXTURE);
  return new File([bytes], "tiny.pdf", { type: "application/pdf" });
}

beforeEach(() => {
  qpdfMock.calls = 0;
  qpdfMock.lastArgs = null;
  qpdfMock.result = {
    data: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]),
    exitCode: 0,
  };
});

describe("repairPdfDescriptor", () => {
  it("declares the expected descriptor fields", () => {
    expect(repairPdfDescriptor.id).toBe("repair-pdf");
    expect(repairPdfDescriptor.fromLabel).toBe("PDF");
    expect(repairPdfDescriptor.toLabel).toBe("Repaired PDF");
    expect(repairPdfDescriptor.accept).toEqual(["application/pdf"]);
    expect(repairPdfDescriptor.newExtension).toBe("pdf");
    expect(typeof repairPdfDescriptor.loadEngine).toBe("function");
    expect(repairPdfDescriptor.setupSizeLabel).toBe("≈ 1.3 MB");
  });

  it("exposes a single linearize checkbox that defaults OFF", () => {
    expect(repairPdfDescriptor.controls).toHaveLength(1);
    const control = repairPdfDescriptor.controls?.[0];
    expect(control).toMatchObject({ type: "checkbox", id: "linearize", default: false });
  });

  it("repairs a valid PDF (happy path): suffixed filename, correct type, non-empty output", async () => {
    const file = await tinyPdfFile();
    const result = await repairPdfDescriptor.convert({ file });

    expect(qpdfMock.calls).toBe(1);
    expect(result.mimeType).toBe("application/pdf");
    // Suffixed so the repaired copy sits beside the original.
    expect(result.filename).toBe("tiny-repaired.pdf");
    expect(result.inputSize).toBe(file.size);
    expect(result.outputSize).toBeGreaterThan(0);

    const outBytes = new Uint8Array(await result.blob.arrayBuffer());
    expect(String.fromCharCode(...outBytes.slice(0, 4))).toBe("%PDF");
  });

  it("runs the plain in/out repair argv when linearize is OFF (default)", async () => {
    const file = await tinyPdfFile();
    await repairPdfDescriptor.convert({ file }); // linearize omitted ⇒ defaults OFF
    expect(qpdfMock.lastArgs).toEqual(["/in/input.pdf", "/out/output.pdf"]);
  });

  it("adds --linearize to the argv only when the toggle is ON", async () => {
    const file = await tinyPdfFile();
    await repairPdfDescriptor.convert({ file, options: { linearize: true } });
    expect(qpdfMock.lastArgs).toEqual(["--linearize", "/in/input.pdf", "/out/output.pdf"]);
  });

  it("rejects a non-PDF file as UNSUPPORTED_INPUT (before touching qpdf)", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(repairPdfDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
    expect(qpdfMock.calls).toBe(0);
  });

  it("maps a file qpdf cannot recover to DECODE_FAILED (non-recoverable)", async () => {
    // Garbage bytes claiming the PDF MIME: qpdf exits non-zero / empty output.
    qpdfMock.result = { data: new Uint8Array(0), exitCode: 2 };
    const file = new File([new Uint8Array([0x00, 0x01, 0x02, 0x03])], "broken.pdf", {
      type: "application/pdf",
    });
    await expect(repairPdfDescriptor.convert({ file })).rejects.toMatchObject({
      code: "DECODE_FAILED",
      recoverable: false,
    });
    expect(qpdfMock.calls).toBe(1);
  });

  it("respects an already-aborted signal as CANCELLED (before touching qpdf)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await tinyPdfFile();
    await expect(
      repairPdfDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
    expect(qpdfMock.calls).toBe(0);
  });
});

// ── wantsLinearize (pure toggle reader, no DOM) ───────────────────────────────

describe("wantsLinearize", () => {
  it("is true only when the toggle is explicitly true", () => {
    expect(wantsLinearize({ linearize: true })).toBe(true);
  });

  it("defaults to false for off/missing/garbage values", () => {
    expect(wantsLinearize({ linearize: false })).toBe(false);
    expect(wantsLinearize({})).toBe(false);
    expect(wantsLinearize(undefined)).toBe(false);
    // Only a real boolean true counts — a stray truthy string must not opt in.
    expect(wantsLinearize({ linearize: "true" })).toBe(false);
    expect(wantsLinearize({ linearize: 1 })).toBe(false);
  });
});

// ── buildRepairArgs (pure qpdf argv, no DOM) ──────────────────────────────────

describe("buildRepairArgs", () => {
  it("returns just the in/out pair when not linearizing", () => {
    expect(buildRepairArgs("/in/input.pdf", "/out/output.pdf", false)).toEqual([
      "/in/input.pdf",
      "/out/output.pdf",
    ]);
  });

  it("prepends --linearize when linearizing (positionals stay last)", () => {
    expect(buildRepairArgs("/in/input.pdf", "/out/output.pdf", true)).toEqual([
      "--linearize",
      "/in/input.pdf",
      "/out/output.pdf",
    ]);
  });
});
