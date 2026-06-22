// One-off, deterministic fixture generator for the Compress PDF tests. Produces
// `image-heavy.pdf` in this directory: a small PDF that embeds the committed
// tiny.jpg as a real /DCTDecode image XObject across two pages, so the
// in-place JPEG re-encode path (Path A) has something to find. pdf-lib is
// already a project dependency. Dates are pinned so the bytes are deterministic
// and re-running is idempotent.
//
//   node src/engine/conversions/__fixtures__/compress-pdf/gen-fixture.mjs
//
import { PDFDocument } from "pdf-lib";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "image-heavy.pdf");
const JPG = join(HERE, "..", "tiny.jpg");

const doc = await PDFDocument.create();
const EPOCH = new Date("2020-01-01T00:00:00Z");
doc.setCreationDate(EPOCH);
doc.setModificationDate(EPOCH);

const jpgBytes = await readFile(JPG);
const img = await doc.embedJpg(jpgBytes);

for (let n = 0; n < 2; n++) {
  const page = doc.addPage([200, 200]);
  // Draw the embedded JPEG large so the image dominates the page (and the file).
  page.drawImage(img, { x: 0, y: 0, width: 200, height: 200 });
}

const bytes = await doc.save();
await writeFile(OUT, bytes);
console.log(`Wrote ${bytes.length} bytes to ${OUT}`);
