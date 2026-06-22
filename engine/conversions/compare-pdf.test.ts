import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { diffLines } from "diff";
import {
  comparePdfDescriptor,
  buildDiffHtml,
  escapeHtml,
  type DiffLinesFn,
} from "./compare-pdf";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, "__fixtures__", "pdf-image", name);

async function fileFromFixture(name: string, mime: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: mime });
}

// The real jsdiff diffLines, injected so buildDiffHtml stays pure (the engine
// never top-level imports `diff`). Typed to the helper's expected signature.
const realDiff = diffLines as unknown as DiffLinesFn;

// Same Node-vs-browser gate as pdf-image.test.ts: extracting a PDF's text layer
// needs pdf.js, whose main build evaluates `new DOMMatrix()` at import time (not
// present in plain Node) plus a Web Worker. So the convert() happy path is
// skipIf-gated; the PURE buildDiffHtml tests and the pre-pdf.js guard paths
// (type gate, cancellation) run unconditionally and keep real coverage.
const canvasAvailable =
  typeof document !== "undefined" &&
  typeof document.createElement === "function" &&
  typeof Worker !== "undefined" &&
  (() => {
    try {
      return document.createElement("canvas").getContext("2d") !== null;
    } catch {
      return false;
    }
  })();

describe("buildDiffHtml", () => {
  it("marks added lines (present in B, absent from A) as added", () => {
    const html = buildDiffHtml("line one\n", "line one\nline two\n", { diffLines: realDiff });
    // The new line is rendered in an "added" row, and the +N summary counts it.
    expect(html).toMatch(/class="row added"[^>]*>.*line two/);
    expect(html).toContain("+1 added");
  });

  it("marks removed lines (present in A, absent from B) as removed", () => {
    const html = buildDiffHtml("keep\ndrop me\n", "keep\n", { diffLines: realDiff });
    expect(html).toMatch(/class="row removed"[^>]*>.*drop me/);
    expect(html).toContain("−1 removed");
  });

  it("reports no differences when the two texts are identical", () => {
    const html = buildDiffHtml("same text\nsecond line\n", "same text\nsecond line\n", {
      diffLines: realDiff,
    });
    expect(html).toContain("No differences");
    expect(html).toContain("+0 added");
    expect(html).toContain("−0 removed");
  });

  it("HTML-escapes untrusted PDF text instead of injecting it raw", () => {
    // textA contains a <script> tag and a bare ampersand — both must be escaped
    // in the output so the report can't execute injected markup.
    const malicious = '<script>alert("xss")</script> tom & jerry\n';
    const html = buildDiffHtml(malicious, "", { diffLines: realDiff });
    // The raw tag must NOT appear; its escaped form must.
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("tom &amp; jerry");
    // The only "<script" allowed is the escaped one; there is no live script tag.
    expect(html).not.toMatch(/<script\b/);
  });

  it("escapeHtml escapes all five HTML-sensitive characters", () => {
    expect(escapeHtml(`& < > " '`)).toBe("&amp; &lt; &gt; &quot; &#39;");
  });

  it("escapes the document labels in the header", () => {
    const html = buildDiffHtml("a\n", "a\n", {
      diffLines: realDiff,
      labelA: "<evil>.pdf",
      labelB: "b.pdf",
    });
    expect(html).toContain("&lt;evil&gt;.pdf");
    expect(html).not.toContain("<evil>.pdf");
  });
});

describe("comparePdfDescriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(comparePdfDescriptor.id).toBe("compare-pdf");
    expect(comparePdfDescriptor.fromLabel).toBe("PDF");
    expect(comparePdfDescriptor.newExtension).toBe("html");
    expect(comparePdfDescriptor.accept).toEqual(["application/pdf"]);
    // loadEngine is required for the multi-MB pdf.js library.
    expect(typeof comparePdfDescriptor.loadEngine).toBe("function");
    // A single "file" control supplies the second PDF (fileB), mirroring
    // watermark-pdf's logoFile control.
    const fileControl = comparePdfDescriptor.controls?.find((c) => c.type === "file");
    expect(fileControl).toBeDefined();
    expect(fileControl?.id).toBe("fileB");
    expect((fileControl as { accept: string[] }).accept).toEqual(["application/pdf"]);
  });

  it("rejects a non-PDF first input as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    const fileB = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "b.pdf", {
      type: "application/pdf",
    });
    await expect(
      comparePdfDescriptor.convert({ file, options: { fileB } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_INPUT", recoverable: false });
  });

  it("rejects a missing second PDF as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "a.pdf", {
      type: "application/pdf",
    });
    // No fileB in options.
    await expect(comparePdfDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED (before any engine load)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "a.pdf", {
      type: "application/pdf",
    });
    const fileB = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "b.pdf", {
      type: "application/pdf",
    });
    await expect(
      comparePdfDescriptor.convert({ file, options: { fileB }, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // Needs the real browser stack (pdf.js + worker) to extract text; skipped in
  // the Node test env. Comparing a PDF against ITSELF must report no differences.
  it.skipIf(!canvasAvailable)("compares two PDFs and emits an HTML report", async () => {
    await comparePdfDescriptor.loadEngine!();
    const file = await fileFromFixture("two-page.pdf", "application/pdf");
    const fileB = await fileFromFixture("two-page.pdf", "application/pdf");
    const result = await comparePdfDescriptor.convert({ file, options: { fileB } });

    expect(result.mimeType).toBe("text/html");
    expect(result.filename).toBe("two-page.html");
    expect(result.outputSize).toBeGreaterThan(0);
    // Same file vs itself ⇒ identical extracted text ⇒ no differences.
    const html = await result.blob.text();
    expect(html).toContain("No differences");
  });
});
