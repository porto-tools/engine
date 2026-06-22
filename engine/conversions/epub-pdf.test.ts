import { describe, it, expect } from "vitest";
import { epubToPdfDescriptor, __test } from "./epub-pdf";

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The full EPUB → PDF pipeline needs browser globals that don't exist in plain
// Node:
//   1. DOMParser — to parse container.xml / the OPF / each XHTML chapter
//   2. createImageBitmap + document.createElement("canvas") — to decode and
//      re-encode inline raster images for jsPDF.addImage
//   3. jsPDF itself runs in Node, but the conversion reaches DOMParser first.
//
// TODO(test-env): wire up a browser/DOM test environment (e.g. vitest browser
// mode or happy-dom/jsdom registered as the test environment) so the heavy
// happy path — unzip → spine → render → Blob — can run in CI against a real
// .epub fixture. Until then the happy path is skip-guarded via it.skipIf.
//
// What DOES run unconditionally here (no browser needed):
//   - all descriptor-field assertions
//   - UNSUPPORTED_INPUT (thrown before any unzip/DOMParser call)
//   - CANCELLED (already-aborted signal throws before any unzip/DOMParser call)
//   - the pure string/path helpers (normalizeText, collapseWhitespace,
//     resolveZipPath, dirOf) which are plain functions
const domAvailable =
  typeof DOMParser !== "undefined" &&
  typeof createImageBitmap === "function" &&
  typeof document !== "undefined" &&
  typeof document.createElement === "function";

describe("epubToPdfDescriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(epubToPdfDescriptor.id).toBe("epub-to-pdf");
    expect(epubToPdfDescriptor.fromLabel).toBe("EPUB");
    expect(epubToPdfDescriptor.toLabel).toBe("PDF");
    expect(epubToPdfDescriptor.newExtension).toBe("pdf");
    expect(epubToPdfDescriptor.accept).toContain("application/epub+zip");
    // Auto-on-drop: no controls, single-input (no inputMode override).
    expect(epubToPdfDescriptor.controls).toBeUndefined();
    expect(epubToPdfDescriptor.inputMode).toBeUndefined();
    expect(epubToPdfDescriptor.outputMode).toBeUndefined();
    // Pure-JS (jsPDF + fflate) — no WASM engine download, so no loadEngine.
    expect(epubToPdfDescriptor.loadEngine).toBeUndefined();
    expect(typeof epubToPdfDescriptor.convert).toBe("function");
  });

  it("rejects a non-EPUB file as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(epubToPdfDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects an empty-MIME file with a non-EPUB extension as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3])], "document.pdf", { type: "" });
    await expect(epubToPdfDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED (before any unzip/DOM work)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "book.epub", {
      type: "application/epub+zip",
    });
    await expect(
      epubToPdfDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("treats an empty-MIME .epub past the type gate, aborting as CANCELLED", async () => {
    // Empty MIME + .epub name must pass the type gate (iOS/drop behaviour),
    // then the already-aborted signal short-circuits to CANCELLED — proving the
    // file was NOT rejected as UNSUPPORTED_INPUT.
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "book.epub", {
      type: "",
    });
    await expect(
      epubToPdfDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });
});

describe("epub-pdf helpers", () => {
  it("isEpubFile accepts the standard MIME and an empty-MIME .epub, rejects others", () => {
    expect(__test.isEpubFile(new File([], "b.epub", { type: "application/epub+zip" }))).toBe(true);
    expect(__test.isEpubFile(new File([], "b.epub", { type: "" }))).toBe(true);
    expect(__test.isEpubFile(new File([], "b.EPUB", { type: "" }))).toBe(true);
    expect(__test.isEpubFile(new File([], "b.pdf", { type: "" }))).toBe(false);
    expect(__test.isEpubFile(new File([], "b.epub", { type: "image/png" }))).toBe(false);
  });

  it("resolveZipPath resolves relative hrefs against a base dir and strips fragments", () => {
    expect(__test.resolveZipPath("OEBPS", "chapter1.xhtml")).toBe("OEBPS/chapter1.xhtml");
    expect(__test.resolveZipPath("OEBPS/text", "../images/cover.jpg")).toBe("OEBPS/images/cover.jpg");
    expect(__test.resolveZipPath("OEBPS", "./ch.xhtml#anchor")).toBe("OEBPS/ch.xhtml");
    expect(__test.resolveZipPath("OEBPS/text", "page.xhtml?x=1")).toBe("OEBPS/text/page.xhtml");
    // A leading slash resets to the archive root.
    expect(__test.resolveZipPath("OEBPS/text", "/OEBPS/cover.jpg")).toBe("OEBPS/cover.jpg");
  });

  it("dirOf returns the directory portion of a zip path", () => {
    expect(__test.dirOf("OEBPS/text/ch.xhtml")).toBe("OEBPS/text");
    expect(__test.dirOf("content.opf")).toBe("");
  });

  it("collapseWhitespace squeezes runs of whitespace and trims", () => {
    expect(__test.collapseWhitespace("  a\n\t  b   c  ")).toBe("a b c");
    expect(__test.collapseWhitespace("\n\n\n")).toBe("");
  });

  it("normalizeText maps common ebook typography to WinAnsi-safe equivalents", () => {
    expect(__test.normalizeText("“hello”")).toBe('"hello"');
    expect(__test.normalizeText("don’t")).toBe("don't");
    expect(__test.normalizeText("a—b")).toBe("a--b");
    expect(__test.normalizeText("x…")).toBe("x...");
    // A non-Latin script char is unrepresentable in WinAnsi → becomes a space.
    expect(__test.normalizeText("a中b")).toBe("a b");
    // Plain ASCII passes through untouched.
    expect(__test.normalizeText("Hello, world!")).toBe("Hello, world!");
  });
});

// TODO(test-env): needs a real DOM env (DOMParser + createImageBitmap + canvas).
// Builds a minimal in-memory EPUB (container.xml + a one-item OPF + one XHTML
// chapter), runs the full unzip → spine → render → Blob pipeline, and asserts a
// non-empty application/pdf Blob with the .pdf filename. Skipped in Node.
describe.skipIf(!domAvailable)("epubToPdfDescriptor happy path", () => {
  it("renders a minimal EPUB into a non-empty PDF", async () => {
    const { zipSync, strToU8 } = await import("fflate");
    const container =
      '<?xml version="1.0"?><container version="1.0" ' +
      'xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
      '<rootfiles><rootfile full-path="OEBPS/content.opf" ' +
      'media-type="application/oebps-package+xml"/></rootfiles></container>';
    const opf =
      '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">' +
      '<manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/></manifest>' +
      '<spine><itemref idref="c1"/></spine></package>';
    const chapter =
      '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>' +
      "<h1>Chapter One</h1><p>The quick brown fox jumps over the lazy dog.</p>" +
      "<ul><li>first</li><li>second</li></ul></body></html>";

    const epub = zipSync({
      "META-INF/container.xml": strToU8(container),
      "OEBPS/content.opf": strToU8(opf),
      "OEBPS/ch1.xhtml": strToU8(chapter),
    });

    const file = new File([epub.slice().buffer], "mybook.epub", {
      type: "application/epub+zip",
    });
    const result = await epubToPdfDescriptor.convert({ file });

    expect(result.mimeType).toBe("application/pdf");
    expect(result.filename).toBe("mybook.pdf");
    expect(result.outputSize).toBeGreaterThan(0);
    expect(result.inputSize).toBe(file.size);
    // A real PDF starts with the %PDF- signature.
    const head = new Uint8Array(await result.blob.slice(0, 5).arrayBuffer());
    expect(String.fromCharCode(...head)).toBe("%PDF-");
  });
});
