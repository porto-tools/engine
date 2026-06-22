// These tests cover everything that runs WITHOUT the qpdf-wasm engine: the
// descriptor shape, the password control, the loadEngine gate, input validation,
// and abort handling. We deliberately do NOT attempt a real decrypt round-trip —
// qpdf-wasm is an Emscripten WASM build that fetches its companion .wasm via a
// browser locateFile and cannot run in Node, so the actual decryption path (and
// the wrong-password error mapping) is exercised by the engine in the browser,
// not here.

import { describe, it, expect } from "vitest";
import { unlockPdfDescriptor } from "./unlock-pdf";

describe("unlockPdfDescriptor", () => {
  it("declares the expected descriptor fields", () => {
    expect(unlockPdfDescriptor.id).toBe("unlock-pdf");
    expect(unlockPdfDescriptor.fromLabel).toBe("PDF");
    expect(unlockPdfDescriptor.toLabel).toBe("Unlocked PDF");
    expect(unlockPdfDescriptor.accept).toEqual(["application/pdf"]);
    expect(unlockPdfDescriptor.newExtension).toBe("pdf");
    expect(typeof unlockPdfDescriptor.loadEngine).toBe("function");
    expect(unlockPdfDescriptor.setupSizeLabel).toBe("≈ 1.3 MB");
  });

  it("exposes a single password text control", () => {
    expect(unlockPdfDescriptor.controls).toHaveLength(1);
    const control = unlockPdfDescriptor.controls?.[0];
    expect(control).toMatchObject({ type: "text", id: "password", label: "Password" });
  });

  it("rejects a non-PDF file as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(
      unlockPdfDescriptor.convert({ file, options: { password: "hunter2" } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: false });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new TextEncoder().encode("%PDF-1.4")], "doc.pdf", {
      type: "application/pdf",
    });
    await expect(
      unlockPdfDescriptor.convert({ file, options: { password: "hunter2" }, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });
});
