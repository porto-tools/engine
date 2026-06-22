// One-off, deterministic fixture generator for the PDF→image conversion tests.
// Produces the tiny 2-page `two-page.pdf` in this directory using pdf-lib
// (already a project dependency). Run once to (re)emit the bytes; the resulting
// PDF is committed and this script is kept alongside it for reproducibility.
// No randomness, no live timestamps — the creation/modification dates are
// pinned, so pdf-lib writes a stable byte stream and re-running is idempotent.
//
//   node src/engine/conversions/__fixtures__/pdf-image/gen-fixture.mjs
//
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "two-page.pdf");

const doc = await PDFDocument.create();
// Pin the dates so the output bytes are deterministic across runs (pdf-lib
// otherwise stamps `new Date()` into the document metadata).
const EPOCH = new Date("2020-01-01T00:00:00Z");
doc.setCreationDate(EPOCH);
doc.setModificationDate(EPOCH);

const font = await doc.embedFont(StandardFonts.Helvetica);

for (let n = 1; n <= 2; n++) {
  const page = doc.addPage([200, 200]); // small — this is a test fixture
  page.drawText(`Page ${n}`, { x: 40, y: 100, size: 24, font, color: rgb(0, 0, 0) });
}

const bytes = await doc.save();
await writeFile(OUT, bytes);
console.log(`Wrote ${bytes.length} bytes to ${OUT}`);
