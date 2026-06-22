// One-off, deterministic fixture generator for the pdf-split "bookmarks" mode
// test. Produces `bookmarked-three-pages.pdf` in this directory: a tiny 3-page
// PDF carrying a flat outline (3 top-level bookmarks, one per page) so the
// integration test can assert splitByBookmarks yields 3 chapter PDFs.
//
//   node src/engine/conversions/__fixtures__/pdf-split/gen-bookmarked-fixture.mjs
//
// pdf-lib has no high-level outline API, so we build the /Outlines dictionary by
// hand using its LOW-LEVEL object model (PDFDict/PDFArray/PDFName/PDFRef…) and
// hang it off the catalog. The structure mirrors the PDF spec's outline tree:
//   Catalog.Outlines → Outlines dict (First, Last, Count)
//     → N sibling outline-item dicts (Title, Parent, Prev/Next, Dest)
// Each item's Dest is an explicit destination array [pageRef, /Fit] so pdf.js'
// getOutline() returns dest as that array (item.dest[0] === the page ref).
//
// No randomness, no live timestamps — the dates are pinned, so pdf-lib writes a
// stable byte stream and re-running is idempotent.

import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFString,
  StandardFonts,
  rgb,
} from "pdf-lib";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "bookmarked-three-pages.pdf");

const doc = await PDFDocument.create();
// Pin the dates so the output bytes are deterministic across runs.
const EPOCH = new Date("2020-01-01T00:00:00Z");
doc.setCreationDate(EPOCH);
doc.setModificationDate(EPOCH);

const font = await doc.embedFont(StandardFonts.Helvetica);
const TITLES = ["Introduction", "Chapter One", "Conclusion"];

const pageRefs = [];
for (let n = 0; n < 3; n++) {
  const page = doc.addPage([200, 200]); // small — this is a test fixture
  page.drawText(TITLES[n], { x: 20, y: 100, size: 18, font, color: rgb(0, 0, 0) });
  pageRefs.push(page.ref);
}

const context = doc.context;

// Reserve the outline-root ref up front so each item can point its Parent at it.
const outlinesRef = context.nextRef();

// Build one outline-item dict per page. Each carries Title, Parent (the root),
// Prev/Next sibling links, and an explicit Dest array [pageRef, /Fit].
const itemRefs = pageRefs.map(() => context.nextRef());
itemRefs.forEach((itemRef, i) => {
  const dict = context.obj({
    Title: PDFString.of(TITLES[i]),
    Parent: outlinesRef,
    Dest: context.obj([pageRefs[i], PDFName.of("Fit")]),
  });
  if (i > 0) dict.set(PDFName.of("Prev"), itemRefs[i - 1]);
  if (i < itemRefs.length - 1) dict.set(PDFName.of("Next"), itemRefs[i + 1]);
  context.assign(itemRef, dict);
});

// The outline root: First/Last sibling pointers + the open item Count.
const outlines = context.obj({
  Type: PDFName.of("Outlines"),
  First: itemRefs[0],
  Last: itemRefs[itemRefs.length - 1],
  Count: PDFNumber.of(itemRefs.length),
});
context.assign(outlinesRef, outlines);

// Hang the outline tree off the document catalog.
doc.catalog.set(PDFName.of("Outlines"), outlinesRef);

const bytes = await doc.save();
await writeFile(OUT, bytes);
console.log(`Wrote ${bytes.length} bytes to ${OUT}`);
