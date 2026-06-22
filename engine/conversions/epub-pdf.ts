// EPUB → PDF — turn a reflowable ebook into a paginated PDF, entirely on-device.
//
// An EPUB is a ZIP of XHTML "chapter" documents plus a manifest (the OPF) and a
// spine that fixes their reading order. We unzip with fflate (the project's
// existing zip dep — decision 0006, no new zip dependency), read the OPF to find
// the spine order, parse each spine document with the browser-native DOMParser,
// pull readable text in document order (headings, paragraphs, list items), and
// flow it into a jsPDF document with margins, word-wrap, and automatic page
// breaks (decision 0011). Inline raster images (jpg/png) referenced by the
// chapter are embedded where they appear when they decode cleanly.
//
// FIDELITY (be honest, here and on the page): we preserve the *text and basic
// structure* — reading order, paragraph breaks, headings, list items, and inline
// raster images. We do NOT reproduce the EPUB's CSS: exact fonts, colours,
// columns, floats, tables, and pixel-level layout are intentionally not carried
// over. The output is a clean, readable, faithful-to-the-words PDF, not a
// pixel-perfect screenshot of a reading app.
//
// This file runs in the browser (DOMParser, createImageBitmap, document/canvas
// are all available at runtime), so using those globals here is fine — the engine
// firewall only forbids importing app/components/lib, not browser globals.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";

// ── Defensive limits ─────────────────────────────────────────────────────────
// A pathological or hostile EPUB must never hang the tab. We cap the number of
// rendered pages, the total characters of text we lay out, and the number of
// images we embed. When a cap is hit we stop cleanly and still emit a valid PDF.
const MAX_PAGES = 2000;
const MAX_TOTAL_CHARS = 5_000_000; // ~5 MB of text; far beyond any real book
const MAX_IMAGES = 500;
const MAX_BLOCK_CHARS = 200_000; // a single absurd text node is truncated

// ── Page geometry (points; 1pt = 1/72 inch) ──────────────────────────────────
const PAGE_MARGIN = 56; // ~0.78in margins all round
const BODY_FONT_SIZE = 11;
const LINE_HEIGHT = 1.45;
const PARAGRAPH_GAP = 6; // extra space after a paragraph
const HEADING_SIZES: Record<number, number> = { 1: 20, 2: 16, 3: 14, 4: 12, 5: 11, 6: 11 };

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ConversionError("Conversion cancelled.", { code: "CANCELLED", recoverable: true });
  }
}

// Accept the standard EPUB MIME and tolerate an empty MIME when the filename ends
// .epub — many OSes/browsers report "" for .epub on drop (same tolerance the MP4
// routes apply to .mp4).
function isEpubFile(file: File): boolean {
  const type = file.type.toLowerCase();
  if (type === "application/epub+zip") return true;
  if (type === "") {
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    return ext === "epub";
  }
  return false;
}

// ── Text normalisation ───────────────────────────────────────────────────────
// jsPDF's bundled fonts (helvetica/times/courier) are WinAnsi-encoded and cover
// Latin-1 only. Rather than bundle a multi-megabyte Unicode TTF, we map the
// common typographic characters that appear in ebooks to safe equivalents so the
// text stays readable, and drop anything still unrepresentable. This keeps the
// dependency footprint to jsPDF alone (no fetched binaries) while preserving the
// words for the overwhelmingly common Latin-script ebook.
const CHAR_MAP: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'", // single quotes
  "“": '"', "”": '"', "„": '"', "‟": '"', // double quotes
  "–": "-", "—": "--", "―": "--", // en/em dashes
  "…": "...", // ellipsis
  " ": " ", " ": " ", " ": " ", " ": " ", // non-breaking/thin spaces
  "•": "* ", "·": "* ", // bullets
  "™": "(TM)", "®": "(R)", "©": "(C)", // marks
  "′": "'", "″": '"', // primes
  "﻿": "", // BOM
};

function normalizeText(input: string): string {
  let out = "";
  for (const ch of input) {
    const mapped = CHAR_MAP[ch];
    if (mapped !== undefined) {
      out += mapped;
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    // Keep tab/newline-collapsed text and any Latin-1 representable char.
    if (code === 9 || code === 10 || (code >= 32 && code <= 255)) {
      out += ch;
    } else {
      // Unrepresentable in WinAnsi (e.g. non-Latin scripts). Substitute a space
      // so word boundaries survive; honest about the fidelity limit.
      out += " ";
    }
  }
  return out;
}

// Collapse runs of whitespace to single spaces and trim. EPUB XHTML is full of
// indentation whitespace between tags that must not become visible gaps.
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ── A flat, ordered list of renderable blocks extracted from a chapter ────────
type BlockKind = "heading" | "paragraph" | "listitem" | "image";
interface TextBlock {
  kind: "heading" | "paragraph" | "listitem";
  text: string;
  level?: number; // for headings: 1..6
}
interface ImageBlock {
  kind: "image";
  href: string; // resolved zip path
}
type Block = TextBlock | ImageBlock;

// ── ZIP path helpers ─────────────────────────────────────────────────────────
// Resolve an href that is relative to a base file inside the zip, returning a
// normalised, slash-separated zip path (no leading slash, no "./"/".." segments).
function resolveZipPath(baseDir: string, href: string): string {
  // Strip any URL fragment/query — chapter links carry #anchors we don't follow.
  const clean = href.split("#")[0].split("?")[0];
  const baseSegments = baseDir ? baseDir.split("/").filter(Boolean) : [];
  const hrefSegments = clean.split("/");
  // An absolute zip path (leading slash) resets to the root.
  const segments = clean.startsWith("/") ? [] : baseSegments.slice();
  for (const seg of hrefSegments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") segments.pop();
    else segments.push(seg);
  }
  return segments.join("/");
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(0, idx) : "";
}

// Look a path up in the unzipped map, tolerating case and percent-encoding
// differences between the OPF's hrefs and the actual zip entry names.
function findEntry(
  files: Record<string, Uint8Array>,
  path: string,
): Uint8Array | undefined {
  if (files[path]) return files[path];
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    /* leave as-is on malformed escapes */
  }
  if (files[decoded]) return files[decoded];
  const lower = decoded.toLowerCase();
  for (const key of Object.keys(files)) {
    if (key.toLowerCase() === lower) return files[key];
    let dk = key;
    try {
      dk = decodeURIComponent(key);
    } catch {
      /* ignore */
    }
    if (dk.toLowerCase() === lower) return files[key];
  }
  return undefined;
}

const TEXT_DECODER = new TextDecoder("utf-8");
function decodeText(bytes: Uint8Array): string {
  return TEXT_DECODER.decode(bytes);
}

// ── EPUB structure parsing ───────────────────────────────────────────────────
function parseXml(xml: string, label: string): Document {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  // DOMParser reports a malformed document via a <parsererror> element rather
  // than throwing.
  if (doc.getElementsByTagName("parsererror").length > 0) {
    throw new ConversionError(`This EPUB's ${label} is malformed and couldn't be read.`, {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: `XML parse error in ${label}.`,
    });
  }
  return doc;
}

// META-INF/container.xml → the full-path of the OPF package document.
function findOpfPath(files: Record<string, Uint8Array>): string {
  const containerBytes = findEntry(files, "META-INF/container.xml");
  if (!containerBytes) {
    throw new ConversionError("This doesn't look like a valid EPUB — its container is missing.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: "META-INF/container.xml not found in the archive.",
    });
  }
  const doc = parseXml(decodeText(containerBytes), "container.xml");
  const rootfile = doc.getElementsByTagName("rootfile")[0];
  const fullPath = rootfile?.getAttribute("full-path");
  if (!fullPath) {
    throw new ConversionError("This EPUB's container doesn't point to a package file.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: "No <rootfile full-path> in META-INF/container.xml.",
    });
  }
  return fullPath.replace(/^\/+/, "");
}

interface SpineDoc {
  path: string; // zip path of the XHTML document
}

// Parse the OPF: map manifest id → href, then walk the spine itemref order.
function parseSpine(opfDoc: Document, opfDir: string): SpineDoc[] {
  const idToHref = new Map<string, string>();
  const manifestItems = opfDoc.getElementsByTagName("item");
  for (let i = 0; i < manifestItems.length; i++) {
    const item = manifestItems[i];
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (id && href) idToHref.set(id, href);
  }

  const spine = opfDoc.getElementsByTagName("itemref");
  const docs: SpineDoc[] = [];
  for (let i = 0; i < spine.length; i++) {
    const idref = spine[i].getAttribute("idref");
    // Honour linear="no" only loosely: most readers still include such items;
    // we include them too so nothing readable is silently dropped.
    if (!idref) continue;
    const href = idToHref.get(idref);
    if (!href) continue;
    docs.push({ path: resolveZipPath(opfDir, href) });
  }
  return docs;
}

// ── XHTML → ordered blocks ───────────────────────────────────────────────────
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "HEAD", "TITLE", "NOSCRIPT"]);
const BLOCK_TAGS = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "BLOCKQUOTE", "PRE", "FIGCAPTION", "TD", "TH",
]);
const HEADING_TAGS: Record<string, number> = {
  H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6,
};

// Walk a chapter document body in document order, emitting blocks. Headings and
// list items are tagged so the renderer can style them; everything else flushes
// as a paragraph at each block boundary. Inline images become image blocks.
function extractBlocks(doc: Document, chapterDir: string): Block[] {
  const body = doc.getElementsByTagName("body")[0] ?? doc.documentElement;
  const blocks: Block[] = [];
  let buffer = ""; // accumulating inline text for the current paragraph

  const flush = (kind: TextBlock["kind"] = "paragraph", level?: number) => {
    const text = collapseWhitespace(buffer);
    buffer = "";
    if (text) blocks.push(level ? { kind, text, level } : { kind, text });
  };

  const walk = (node: Node) => {
    if (blocks.length > MAX_PAGES * 4) return; // hard structural ceiling
    const type = node.nodeType;
    if (type === 3 /* TEXT_NODE */) {
      const value = node.nodeValue ?? "";
      buffer += value.length > MAX_BLOCK_CHARS ? value.slice(0, MAX_BLOCK_CHARS) : value;
      return;
    }
    if (type !== 1 /* ELEMENT_NODE */) return;

    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return;

    if (tag === "BR") {
      buffer += " ";
      return;
    }

    if (tag === "IMG" || tag === "IMAGE") {
      // Flush any pending text first so image lands in reading order.
      flush();
      const src =
        el.getAttribute("src") ||
        el.getAttribute("xlink:href") ||
        el.getAttribute("href") ||
        "";
      if (src) blocks.push({ kind: "image", href: resolveZipPath(chapterDir, src) });
      return;
    }

    const headingLevel = HEADING_TAGS[tag];
    if (headingLevel) {
      flush();
      for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
      flush("heading", headingLevel);
      return;
    }

    if (tag === "LI") {
      flush();
      for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
      flush("listitem");
      return;
    }

    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) flush();
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
    if (isBlock) flush();
  };

  walk(body);
  flush();
  return blocks;
}

// ── jsPDF rendering ──────────────────────────────────────────────────────────
type JsPDFDoc = import("jspdf").jsPDF;

interface RenderState {
  doc: JsPDFDoc;
  pageHeight: number;
  pageWidth: number;
  contentWidth: number;
  y: number;
  totalChars: number;
  imagesEmbedded: number;
  pageCount: number; // pages we've started (1-based)
  limitHit: boolean;
}

function newPageIfNeeded(state: RenderState, needed: number): boolean {
  if (state.y + needed <= state.pageHeight - PAGE_MARGIN) return true;
  if (state.pageCount >= MAX_PAGES) {
    state.limitHit = true;
    return false;
  }
  state.doc.addPage();
  state.pageCount += 1;
  state.y = PAGE_MARGIN;
  return true;
}

function renderTextBlock(state: RenderState, block: TextBlock): void {
  if (state.limitHit) return;
  const { doc } = state;
  const isHeading = block.kind === "heading";
  const fontSize = isHeading ? HEADING_SIZES[block.level ?? 2] ?? 14 : BODY_FONT_SIZE;
  doc.setFont("times", isHeading ? "bold" : "normal");
  doc.setFontSize(fontSize);

  const lineGap = fontSize * LINE_HEIGHT;
  const prefix = block.kind === "listitem" ? "•  " : "";
  const indentForWrap = block.kind === "listitem" ? doc.getTextWidth("•  ") : 0;
  const wrapWidth = state.contentWidth - indentForWrap;

  const raw = normalizeText(block.text);
  const lines: string[] = doc.splitTextToSize(raw, wrapWidth);

  // A little breathing room above headings (but not at the top of a page).
  if (isHeading && state.y > PAGE_MARGIN) {
    state.y += fontSize * 0.5;
  }

  for (let i = 0; i < lines.length; i++) {
    if (!newPageIfNeeded(state, lineGap)) return;
    const text = i === 0 ? `${prefix}${lines[i]}` : lines[i];
    const x = PAGE_MARGIN + (i === 0 ? 0 : indentForWrap);
    doc.text(text, x, state.y, { baseline: "top" });
    state.y += lineGap;
  }
  state.y += PARAGRAPH_GAP;
}

// Decode an image's bytes to a data URL + natural size via createImageBitmap and
// a canvas. Returns null if the image can't be decoded (we then skip it rather
// than fail the whole conversion).
async function decodeImage(
  bytes: Uint8Array,
  mime: string,
): Promise<{ dataUrl: string; width: number; height: number; format: string } | null> {
  try {
    const blob = new Blob([bytes.slice().buffer], { type: mime });
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bitmap.close();
      return null;
    }
    ctx.drawImage(bitmap, 0, 0);
    const width = bitmap.width;
    const height = bitmap.height;
    bitmap.close();
    const isPng = mime === "image/png";
    const dataUrl = canvas.toDataURL(isPng ? "image/png" : "image/jpeg", 0.85);
    return { dataUrl, width, height, format: isPng ? "PNG" : "JPEG" };
  } catch {
    return null;
  }
}

const IMAGE_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

async function renderImageBlock(
  state: RenderState,
  block: ImageBlock,
  files: Record<string, Uint8Array>,
): Promise<void> {
  if (state.limitHit || state.imagesEmbedded >= MAX_IMAGES) return;
  const ext = block.href.split(".").pop()?.toLowerCase() ?? "";
  const mime = IMAGE_MIME[ext];
  if (!mime) return; // only embed raster jpg/png; svg/gif/etc. are skipped
  const bytes = findEntry(files, block.href);
  if (!bytes) return;

  const decoded = await decodeImage(bytes, mime);
  if (!decoded) return;

  // Fit the image within the content box, preserving aspect ratio. Cap height so
  // a tall image still leaves room and paginates instead of overflowing.
  const maxW = state.contentWidth;
  const maxH = state.pageHeight - 2 * PAGE_MARGIN;
  let w = decoded.width;
  let h = decoded.height;
  if (w <= 0 || h <= 0) return;
  const scale = Math.min(maxW / w, maxH / h, 1);
  // Upscale small images modestly so they aren't a tiny speck, but never beyond
  // the content width.
  const finalScale = scale < 1 ? scale : Math.min(maxW / w, maxH / h);
  w = w * finalScale;
  h = h * finalScale;

  if (!newPageIfNeeded(state, h + PARAGRAPH_GAP)) return;
  try {
    state.doc.addImage(decoded.dataUrl, decoded.format, PAGE_MARGIN, state.y, w, h);
    state.y += h + PARAGRAPH_GAP;
    state.imagesEmbedded += 1;
  } catch {
    // A jsPDF embed failure on one image must not sink the whole document.
  }
}

async function convertEpubToPdf(input: ConversionInput): Promise<ConversionResult> {
  const { file, signal, onProgress } = input;

  throwIfAborted(signal);

  if (!isEpubFile(file)) {
    throw new ConversionError("This doesn't look like an EPUB file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected application/epub+zip, received "${file.type || "unknown type"}".`,
    });
  }

  onProgress?.({ stage: "Reading EPUB" });
  let archiveBytes: Uint8Array;
  try {
    archiveBytes = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    throw new ConversionError("We couldn't read this file — it may be damaged.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }

  throwIfAborted(signal);

  // Unzip with fflate (reuse the project's existing zip dep — no new zip dep).
  const { unzipSync } = await import("fflate");
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(archiveBytes);
  } catch (err) {
    throw new ConversionError(
      "We couldn't open this EPUB — it may be corrupt, encrypted, or not a real EPUB.",
      {
        code: "DECODE_FAILED",
        recoverable: false,
        technical: err instanceof Error ? err.message : String(err),
      },
    );
  }

  // DRM/encryption marker: an Adobe/EPUB-protected book carries this file. We
  // can't decrypt it on-device, so fail with a clear, honest message.
  if (findEntry(files, "META-INF/encryption.xml")) {
    throw new ConversionError(
      "This EPUB is DRM-protected, so its contents can't be converted.",
      {
        code: "UNSUPPORTED_INPUT",
        recoverable: false,
        technical: "META-INF/encryption.xml present — the archive is encrypted.",
      },
    );
  }

  throwIfAborted(signal);

  onProgress?.({ stage: "Reading structure" });
  const opfPath = findOpfPath(files);
  const opfBytes = findEntry(files, opfPath);
  if (!opfBytes) {
    throw new ConversionError("This EPUB's package file is missing.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: `OPF "${opfPath}" referenced by container.xml not found.`,
    });
  }
  const opfDoc = parseXml(decodeText(opfBytes), "package file");
  const opfDir = dirOf(opfPath);
  const spine = parseSpine(opfDoc, opfDir);

  if (spine.length === 0) {
    throw new ConversionError("This EPUB has no readable chapters in its spine.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: "Spine resolved to 0 documents.",
    });
  }

  // Build the PDF. jsPDF in points, A4 portrait, with PDF compression on.
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "pt", format: "a4", compress: true });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  const state: RenderState = {
    doc,
    pageWidth,
    pageHeight,
    contentWidth: pageWidth - 2 * PAGE_MARGIN,
    y: PAGE_MARGIN,
    totalChars: 0,
    imagesEmbedded: 0,
    pageCount: 1,
    limitHit: false,
  };

  for (let i = 0; i < spine.length; i++) {
    // Honour the abort signal between chapters — the natural cancellation point.
    throwIfAborted(signal);
    if (state.limitHit || state.totalChars >= MAX_TOTAL_CHARS) break;

    onProgress?.({
      stage: `Rendering chapter ${i + 1} of ${spine.length}`,
      ratio: i / spine.length,
    });

    const chapter = spine[i];
    const bytes = findEntry(files, chapter.path);
    if (!bytes) continue; // a manifest href that doesn't resolve is skipped

    let chapterDoc: Document;
    try {
      chapterDoc = new DOMParser().parseFromString(decodeText(bytes), "application/xhtml+xml");
      // Fall back to lenient HTML parsing if the strict XHTML parse errored.
      if (chapterDoc.getElementsByTagName("parsererror").length > 0) {
        chapterDoc = new DOMParser().parseFromString(decodeText(bytes), "text/html");
      }
    } catch {
      continue; // a single broken chapter shouldn't sink the book
    }

    const chapterDir = dirOf(chapter.path);
    const blocks = extractBlocks(chapterDoc, chapterDir);
    if (blocks.length === 0) continue;

    // New chapter starts on a fresh page (after the first), so chapters don't run
    // together. Skipped when we're already at the top of a blank page.
    if (i > 0 && state.y > PAGE_MARGIN) {
      if (state.pageCount >= MAX_PAGES) {
        state.limitHit = true;
        break;
      }
      doc.addPage();
      state.pageCount += 1;
      state.y = PAGE_MARGIN;
    }

    for (const block of blocks) {
      if (state.limitHit || state.totalChars >= MAX_TOTAL_CHARS) break;
      if (block.kind === "image") {
        await renderImageBlock(state, block, files);
      } else {
        state.totalChars += block.text.length;
        renderTextBlock(state, block);
      }
    }
  }

  throwIfAborted(signal);

  onProgress?.({ stage: "Saving" });
  const arrayBuffer = doc.output("arraybuffer");
  const blob = new Blob([arrayBuffer], { type: "application/pdf" });

  return {
    blob,
    filename: replaceExtension(file.name, "pdf"),
    mimeType: "application/pdf",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const epubToPdfDescriptor: ConversionDescriptor = {
  id: "epub-to-pdf",
  fromLabel: "EPUB",
  toLabel: "PDF",
  // Standard EPUB MIME; empty MIME with a .epub name is tolerated in convert().
  accept: ["application/epub+zip"],
  newExtension: "pdf",
  convert: convertEpubToPdf,
};

// Exported for unit tests of the pure helpers (no behaviour change for callers).
export const __test = {
  isEpubFile,
  resolveZipPath,
  normalizeText,
  collapseWhitespace,
  findOpfPath,
  parseSpine,
  extractBlocks,
  dirOf,
};

// Re-export the block types for tests without widening the runtime surface.
export type { Block, TextBlock, ImageBlock, BlockKind };
