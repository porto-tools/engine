// PDF to PDF/A (best-effort) — apply the PDF/A-1b PREPARATION steps that pdf-lib
// can honestly perform in the browser, and label the result, plainly, as NOT a
// validated/certified ISO-19005 conversion.
//
// HONESTY IS THE POINT. True PDF/A conformance additionally requires embedding
// every used font, removing transparency/encryption, colour-managing all images,
// and passing a preflight validator — none of which pdf-lib can do or verify in
// the browser. So this tool does ONLY the subset it can do correctly, and the UI
// copy + FAQ say so without overclaiming. The three real steps, all verified to
// survive a save/reload round-trip:
//
//   1. Document metadata — Title / Author / Creator / creation date via pdf-lib's
//      high-level setters. (pdf-lib overwrites /Producer and /ModDate with its own
//      values at save() time; we do not fight that, and we do not claim to set them.)
//   2. An sRGB OUTPUT INTENT — a real, structurally-valid sRGB IEC61966-2.1 ICC v2
//      profile (the SRGB_ICC_BASE64 constant below) embedded as a stream, referenced
//      by an /OutputIntent dict with subtype /GTS_PDFA1 in the catalog's
//      /OutputIntents array. This is the PDF/A device-independent-colour anchor.
//   3. A PDF/A IDENTIFICATION XMP packet — an XMP /Metadata stream carrying
//      pdfaid:part=1 and pdfaid:conformance=B (the PDF/A-1b marker), set on the
//      catalog's /Metadata entry.
//
// And it guarantees the output is NOT encrypted (we never apply encryption; a
// successfully-loaded input is re-saved without it).
//
// What it deliberately does NOT do (and the copy says so): embed missing fonts,
// fix transparency, validate conformance, or certify anything. For guaranteed
// ISO-19005 output, a dedicated preflight tool is required.
//
// pdf-lib is pure JS (no WASM), so no `loadEngine` is needed; it is lazy-loaded
// inside `convert` so it stays in the /pdf-to-pdfa route chunk only.
//
// Engine firewall: imports ONLY ../types, ../filename, ./abort, ./pdf-lib-load,
// and node_modules pdf-lib. Nothing from app/, components/, or lib/.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { throwIfAborted } from "./abort";
import { loadPdfDocument } from "./pdf-lib-load";

// The canonical sRGB IEC61966-2.1 reference ICC profile (3144 bytes — the
// freely-redistributable HP/Microsoft sRGB profile). Embedded inline (base64) so
// the engine firewall holds: no external file import, no network. This is the
// OutputIntent's DestOutputProfile, so a "labeled sRGB" output intent IS genuinely
// sRGB. (Swapped in per Headmaster dispatch #B-002, replacing an earlier minimal
// gamma-2.2 approximation.)
const SRGB_ICC_BASE64 =
  "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";

// The PDF/A-1b identification XMP packet. The pdfaid:part / pdfaid:conformance
// pair is the marker a PDF/A reader looks for; dc:format states the MIME type.
const PDFA_XMP =
  '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
  '<x:xmpmeta xmlns:x="adobe:ns:meta/">' +
  '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">' +
  "<pdfaid:part>1</pdfaid:part>" +
  "<pdfaid:conformance>B</pdfaid:conformance>" +
  "</rdf:Description>" +
  '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
  "<dc:format>application/pdf</dc:format>" +
  "</rdf:Description>" +
  "</rdf:RDF></x:xmpmeta>" +
  '<?xpacket end="w"?>';

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function convertPdfToPdfa(input: ConversionInput): Promise<ConversionResult> {
  const { file, signal, onProgress } = input;

  throwIfAborted(signal);

  if (file.type !== "application/pdf") {
    throw new ConversionError("This doesn't look like a PDF file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected application/pdf, received "${file.type || "unknown type"}".`,
    });
  }

  // Lazy-load pdf-lib so it stays in the /pdf-to-pdfa route chunk only. A failure
  // here is the library failing to load, not the file failing to parse.
  let PDFDocument, PDFName, PDFNumber, PDFString, PDFRawStream;
  try {
    ({ PDFDocument, PDFName, PDFNumber, PDFString, PDFRawStream } = await import("pdf-lib"));
  } catch (err) {
    throw new ConversionError("We couldn't load the PDF engine. Check your connection and try again.", {
      code: "ENGINE_LOAD_FAILED",
      recoverable: true,
      technical: err instanceof Error ? err.message : String(err),
    });
  }

  throwIfAborted(signal);

  onProgress?.({ stage: "Reading" });

  const doc = await loadPdfDocument(
    PDFDocument,
    file,
    "We couldn't read this PDF — the file may be damaged or encrypted.",
  );

  throwIfAborted(signal);

  onProgress?.({ stage: "Preparing PDF/A" });

  const ctx = doc.context;

  // 1. Document metadata. Title falls back to the file's basename so the output
  //    always carries a title (a PDF/A expectation). Author is left untouched if
  //    the source set one; Creator records the tool. Producer/ModDate are written
  //    by pdf-lib at save() — out of our hands, so we don't claim them.
  if (!doc.getTitle()) {
    const dot = file.name.lastIndexOf(".");
    doc.setTitle(dot > 0 ? file.name.slice(0, dot) : file.name);
  }
  doc.setCreator("porto.tools — best-effort PDF/A-1b preparation");
  const now = new Date();
  if (!doc.getCreationDate()) doc.setCreationDate(now);
  doc.setModificationDate(now);

  // 2. sRGB output intent: embed the ICC profile as a stream and reference it from
  //    an /OutputIntent (subtype /GTS_PDFA1) in the catalog's /OutputIntents array.
  const iccBytes = base64ToBytes(SRGB_ICC_BASE64);
  const iccStream = PDFRawStream.of(ctx.obj({ N: PDFNumber.of(3) }), iccBytes);
  const iccRef = ctx.register(iccStream);
  const outputIntent = ctx.obj({
    Type: PDFName.of("OutputIntent"),
    S: PDFName.of("GTS_PDFA1"),
    OutputConditionIdentifier: PDFString.of("sRGB IEC61966-2.1"),
    Info: PDFString.of("sRGB IEC61966-2.1"),
    DestOutputProfile: iccRef,
  });
  doc.catalog.set(PDFName.of("OutputIntents"), ctx.obj([outputIntent]));

  throwIfAborted(signal);

  // 3. PDF/A identification XMP: an XMP /Metadata stream carrying pdfaid:part=1 and
  //    pdfaid:conformance=B, set on the catalog's /Metadata entry.
  const xmpStream = PDFRawStream.of(
    ctx.obj({ Type: PDFName.of("Metadata"), Subtype: PDFName.of("XML") }),
    new TextEncoder().encode(PDFA_XMP),
  );
  doc.catalog.set(PDFName.of("Metadata"), ctx.register(xmpStream));

  throwIfAborted(signal);

  onProgress?.({ stage: "Saving" });

  // useObjectStreams:false keeps the cross-reference table classic (an
  // object-stream xref is itself disallowed in PDF/A-1) and the output legible. We
  // never apply encryption, so the result is unencrypted by construction.
  const saved = await doc.save({ useObjectStreams: false });
  const blob = new Blob([new Uint8Array(saved)], { type: "application/pdf" });

  // Output name: original basename + "-pdfa.pdf" (e.g. report.pdf → report-pdfa.pdf).
  // replaceExtension normalises the source extension to .pdf first.
  const base = replaceExtension(file.name, "pdf").replace(/\.pdf$/i, "");

  return {
    blob,
    filename: `${base}-pdfa.pdf`,
    mimeType: "application/pdf",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const pdfToPdfaDescriptor: ConversionDescriptor = {
  id: "pdf-to-pdfa",
  fromLabel: "PDF",
  toLabel: "PDF/A (best-effort)",
  accept: ["application/pdf"],
  newExtension: "pdf",
  convert: convertPdfToPdfa,
};
