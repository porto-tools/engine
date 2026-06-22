// These tests cover the protect-pdf descriptor: its shape, the password + owner +
// permission controls, input validation, the empty-password rejection, abort
// handling, and the qpdf argv the descriptor builds for both default and
// non-default permissions.
//
// qpdf-wasm is an Emscripten WASM build that fetches its companion .wasm via a
// browser locateFile and cannot run in Node, so we never attempt a real encrypt
// round-trip. Instead we mock the shared ./qpdf module: the stubbed runQpdf
// invokes the descriptor's buildArgs(inPath, outPath) callback and records the
// resulting argv, then returns a fake successful run. That lets us assert the
// exact flags the descriptor emits (the cheapest reliable check) and exercise the
// happy path, while the validation/abort paths short-circuit before runQpdf and
// so never touch the engine.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Records the last argv the descriptor passed to qpdf, plus the next fake result.
const qpdfMock = vi.hoisted(() => ({
  lastArgs: null as string[] | null,
  result: { data: new Uint8Array([1, 2, 3]), exitCode: 0 },
}));

vi.mock("./qpdf", () => ({
  loadQpdf: vi.fn(async () => () => {}),
  // Mirror the real signature: runQpdf(file, buildArgs, signal). We call buildArgs
  // with the same fixed in/out paths the real loader uses so the recorded argv is
  // exactly what qpdf would receive.
  runQpdf: vi.fn(async (_file: File, buildArgs: (i: string, o: string) => string[]) => {
    qpdfMock.lastArgs = buildArgs("/in/input.pdf", "/out/output.pdf");
    return qpdfMock.result;
  }),
}));

import { protectPdfDescriptor } from "./protect-pdf";

function pdfFile(name = "doc.pdf"): File {
  return new File([new TextEncoder().encode("%PDF-1.4")], name, { type: "application/pdf" });
}

beforeEach(() => {
  qpdfMock.lastArgs = null;
  qpdfMock.result = { data: new Uint8Array([1, 2, 3]), exitCode: 0 };
});

describe("protectPdfDescriptor", () => {
  it("declares the expected descriptor fields", () => {
    expect(protectPdfDescriptor.id).toBe("protect-pdf");
    expect(protectPdfDescriptor.fromLabel).toBe("PDF");
    expect(protectPdfDescriptor.toLabel).toBe("Protected PDF");
    expect(protectPdfDescriptor.accept).toEqual(["application/pdf"]);
    expect(protectPdfDescriptor.newExtension).toBe("pdf");
    expect(typeof protectPdfDescriptor.loadEngine).toBe("function");
    expect(protectPdfDescriptor.setupSizeLabel).toBe("≈ 1.3 MB");
  });

  it("exposes open + owner password text controls and the permission controls", () => {
    const controls = protectPdfDescriptor.controls ?? [];
    // open + owner passwords, printing select, and six permission checkboxes.
    expect(controls).toHaveLength(9);
    expect(controls[0]).toMatchObject({ type: "text", id: "password", label: "Open password" });
    expect(controls[1]).toMatchObject({ type: "text", id: "ownerPassword" });
    expect(controls.find((c) => c.id === "printing")).toMatchObject({
      type: "select",
      default: "full",
    });
    const checkboxIds = controls.filter((c) => c.type === "checkbox").map((c) => c.id);
    expect(checkboxIds).toEqual([
      "allowCopy",
      "allowModify",
      "allowAnnotate",
      "allowForm",
      "allowAccessibility",
      "allowAssembly",
    ]);
    // Every permission checkbox defaults to ON (allowed).
    for (const c of controls) {
      if (c.type === "checkbox") expect(c.default).toBe(true);
    }
  });

  it("encrypts with default options: AES-256, owner reuses open password, all permissions allowed", async () => {
    const result = await protectPdfDescriptor.convert({
      file: pdfFile(),
      options: { password: "hunter2" },
    });

    expect(result.mimeType).toBe("application/pdf");
    expect(result.filename).toBe("doc.pdf");
    expect(result.outputSize).toBeGreaterThan(0);

    // owner-pw defaults to the open password; printing full; every toggle = y.
    expect(qpdfMock.lastArgs).toEqual([
      "--encrypt",
      "hunter2",
      "hunter2",
      "256",
      "--print=full",
      "--extract=y",
      "--modify-other=y",
      "--annotate=y",
      "--form=y",
      "--accessibility=y",
      "--assemble=y",
      "--",
      "/in/input.pdf",
      "/out/output.pdf",
    ]);
  });

  it("uses a distinct owner password when supplied", async () => {
    await protectPdfDescriptor.convert({
      file: pdfFile(),
      options: { password: "open-me", ownerPassword: "owner-secret" },
    });
    expect(qpdfMock.lastArgs?.slice(0, 4)).toEqual(["--encrypt", "open-me", "owner-secret", "256"]);
  });

  it("emits restriction flags for non-default permissions (no print, no copy, no assembly)", async () => {
    await protectPdfDescriptor.convert({
      file: pdfFile(),
      options: {
        password: "hunter2",
        printing: "none",
        allowCopy: false,
        allowAssembly: false,
      },
    });
    // Assert the FULL ordered argv: this locks both the y/n mapping AND the
    // positions — every restriction flag must sit after "256" and before "--",
    // which is what qpdf 11.7.0 requires for the modern --encrypt form.
    expect(qpdfMock.lastArgs).toEqual([
      "--encrypt",
      "hunter2",
      "hunter2",
      "256",
      "--print=none",
      "--extract=n",
      "--modify-other=y",
      "--annotate=y",
      "--form=y",
      "--accessibility=y",
      "--assemble=n",
      "--",
      "/in/input.pdf",
      "/out/output.pdf",
    ]);
  });

  it("clamps an unknown printing value back to full (allow)", async () => {
    await protectPdfDescriptor.convert({
      file: pdfFile(),
      // A bogus printing value (options is Record<string, unknown>, so this is
      // valid TS) must be clamped, never passed through to qpdf.
      options: { password: "hunter2", printing: "bogus" },
    });
    expect(qpdfMock.lastArgs).toContain("--print=full");
  });

  it("rejects a non-PDF file as UNSUPPORTED_INPUT (non-recoverable)", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(
      protectPdfDescriptor.convert({ file, options: { password: "hunter2" } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: false });
  });

  it("rejects an empty or whitespace open password as a recoverable UNSUPPORTED_INPUT", async () => {
    await expect(
      protectPdfDescriptor.convert({ file: pdfFile(), options: { password: "" } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: true });
    await expect(
      protectPdfDescriptor.convert({ file: pdfFile(), options: { password: "   " } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: true });
  });

  it("maps a non-zero qpdf exit / empty output to DECODE_FAILED", async () => {
    qpdfMock.result = { data: new Uint8Array(0), exitCode: 2 };
    await expect(
      protectPdfDescriptor.convert({ file: pdfFile(), options: { password: "hunter2" } }),
    ).rejects.toMatchObject({ code: "DECODE_FAILED", recoverable: false });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      protectPdfDescriptor.convert({
        file: pdfFile(),
        options: { password: "hunter2" },
        signal: ctrl.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });
});
