// pdf-lib is pure JavaScript — no WASM and no browser APIs — so all tests run
// in Node without skip-guards.
//
// TODO(test-env): rotation is a pure pdf-lib operation with no browser deps;
// all tests here are expected to pass without a browser environment.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rotatePdfPagesDescriptor } from "./rotate-pdf-pages";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, "__fixtures__", "pdf-split", name);

async function fileFromFixture(name: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: "application/pdf" });
}

// Load a result blob back into a PDFDocument and read each page's rotation.
async function rotationsOf(blob: Blob): Promise<number[]> {
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(await blob.arrayBuffer());
  const out: number[] = [];
  for (let i = 0; i < doc.getPageCount(); i++) {
    out.push(doc.getPage(i).getRotation().angle);
  }
  return out;
}

describe("rotatePdfPagesDescriptor", () => {
  it("rotates all pages 90 degrees when pages is empty (allowAll)", async () => {
    const file = await fileFromFixture("three-pages.pdf");
    const result = await rotatePdfPagesDescriptor.convert({
      file,
      options: { angle: "90", pages: "" },
    });

    expect(result.mimeType).toBe("application/pdf");
    expect(result.filename).toBe("three-pages-rotated.pdf");
    expect(result.outputSize).toBeGreaterThan(0);
    expect(await rotationsOf(result.blob)).toEqual([90, 90, 90]);
  });

  it("rotates only the specified pages and leaves others unchanged", async () => {
    const file = await fileFromFixture("three-pages.pdf");
    const result = await rotatePdfPagesDescriptor.convert({
      file,
      options: { angle: "180", pages: "2" },
    });
    // Page 2 should be 180, pages 1 and 3 should be 0.
    expect(await rotationsOf(result.blob)).toEqual([0, 180, 0]);
  });

  it("rotates a multi-part range (1,3) and leaves the gap untouched", async () => {
    const file = await fileFromFixture("three-pages.pdf");
    const result = await rotatePdfPagesDescriptor.convert({
      file,
      options: { angle: "90", pages: "1,3" },
    });
    expect(await rotationsOf(result.blob)).toEqual([90, 0, 90]);
  });

  it("accumulates rotation on already-rotated pages", async () => {
    const file = await fileFromFixture("three-pages.pdf");
    // Rotate page 1 by 90, then rotate again by 90 — should end up at 180.
    const step1 = await rotatePdfPagesDescriptor.convert({
      file,
      options: { angle: "90", pages: "1" },
    });
    const step1File = new File([await step1.blob.arrayBuffer()], "step1.pdf", {
      type: "application/pdf",
    });
    const step2 = await rotatePdfPagesDescriptor.convert({
      file: step1File,
      options: { angle: "90", pages: "1" },
    });
    expect((await rotationsOf(step2.blob))[0]).toBe(180);
  });

  it("wraps past a full turn (270 + 180 = 90)", async () => {
    const file = await fileFromFixture("three-pages.pdf");
    const step1 = await rotatePdfPagesDescriptor.convert({
      file,
      options: { angle: "270", pages: "1" },
    });
    const step1File = new File([await step1.blob.arrayBuffer()], "step1.pdf", {
      type: "application/pdf",
    });
    const step2 = await rotatePdfPagesDescriptor.convert({
      file: step1File,
      options: { angle: "180", pages: "1" },
    });
    expect((await rotationsOf(step2.blob))[0]).toBe(90);
  });

  it("treats a 0 degree angle as a no-op (pages stay upright)", async () => {
    const file = await fileFromFixture("three-pages.pdf");
    const result = await rotatePdfPagesDescriptor.convert({
      file,
      options: { angle: "0", pages: "" },
    });
    expect(await rotationsOf(result.blob)).toEqual([0, 0, 0]);
  });

  it("normalises a negative angle (-90 wraps to 270)", async () => {
    const file = await fileFromFixture("three-pages.pdf");
    const result = await rotatePdfPagesDescriptor.convert({
      file,
      options: { angle: "-90", pages: "1" },
    });
    expect((await rotationsOf(result.blob))[0]).toBe(270);
  });

  it("normalises a full turn (360 wraps to 0)", async () => {
    const file = await fileFromFixture("three-pages.pdf");
    const result = await rotatePdfPagesDescriptor.convert({
      file,
      options: { angle: "360", pages: "1" },
    });
    expect((await rotationsOf(result.blob))[0]).toBe(0);
  });

  it("snaps an off-axis angle to the nearest quarter turn (rejected by setRotation otherwise)", async () => {
    const file = await fileFromFixture("three-pages.pdf");
    // 47° is not a multiple of 90 — pdf-lib's setRotation would throw on it. The
    // engine must snap it (to 90) rather than let the rotation reach setRotation raw.
    const result = await rotatePdfPagesDescriptor.convert({
      file,
      options: { angle: "47", pages: "1" },
    });
    expect((await rotationsOf(result.blob))[0]).toBe(90);
  });

  it("falls back to a no-op for a missing/unparseable angle", async () => {
    const file = await fileFromFixture("three-pages.pdf");
    const result = await rotatePdfPagesDescriptor.convert({
      file,
      options: { pages: "" },
    });
    expect(await rotationsOf(result.blob)).toEqual([0, 0, 0]);
  });

  it("rejects unsupported input as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3])], "image.png", {
      type: "image/png",
    });
    await expect(
      rotatePdfPagesDescriptor.convert({ file, options: { angle: "90", pages: "" } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: false });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("three-pages.pdf");
    await expect(
      rotatePdfPagesDescriptor.convert({
        file,
        options: { angle: "90", pages: "" },
        signal: ctrl.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });
});
