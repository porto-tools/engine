// Repair PDF — recover a damaged or unopenable PDF by having qpdf re-read and
// rewrite it. qpdf parses the file as forgivingly as it can: it rebuilds a
// broken or missing cross-reference table, fixes damaged object/stream structure
// it can recover, and writes out a fresh, well-formed PDF. This fixes the most
// common reasons a viewer refuses to open a file ("damaged", "could not repair",
// broken xref). It runs entirely in the browser via the shared qpdf-wasm loader,
// so the file never leaves the device.
//
// Honest scope: qpdf repairs STRUCTURE. It recovers files whose container is
// corrupt but whose content objects still exist. It does NOT reconstruct content
// that was genuinely lost — truncated/overwritten page data can't be conjured
// back, and a file that is too far gone simply fails (DECODE_FAILED). We never
// claim more than a structural rewrite.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { throwIfAborted } from "./abort";
import { runQpdf, loadQpdf } from "./qpdf";

function assertSupported(file: File): void {
  if (file.type !== "application/pdf") {
    throw new ConversionError("This doesn't look like a PDF file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected application/pdf, received "${file.type || "unknown type"}".`,
    });
  }
}

// Read the "Optimize for web (linearize)" toggle defensively — options arrive
// untyped, so only an explicit boolean `true` opts in. Anything else leaves it
// OFF (the default). Pure → unit-testable.
export function wantsLinearize(options: ConversionInput["options"]): boolean {
  return options?.linearize === true;
}

// The exact qpdf argv for the repair pass. qpdf always reconstructs the file's
// structure on read and writes a clean copy on output, so the plain in/out pair
// IS the repair. `--linearize` (optional) additionally rewrites the result
// web-optimized. Pure so the argv is locked by a unit test independent of wasm.
export function buildRepairArgs(inPath: string, outPath: string, linearize: boolean): string[] {
  return linearize ? ["--linearize", inPath, outPath] : [inPath, outPath];
}

async function convertRepairPdf(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  const linearize = wantsLinearize(options);

  throwIfAborted(signal);
  onProgress?.({ stage: "Repairing" });

  // qpdf re-reads the (possibly damaged) PDF and writes a freshly normalised copy,
  // rebuilding the cross-reference table and other recoverable structure as it
  // goes. A file too damaged for qpdf to recover yields a non-zero exit code (or
  // empty output), which we map to an honest, non-recoverable error.
  const { exitCode, data } = await runQpdf(
    file,
    (inPath, outPath) => buildRepairArgs(inPath, outPath, linearize),
    signal,
  );
  throwIfAborted(signal);

  if (exitCode !== 0 || data.length === 0) {
    throw new ConversionError("This PDF is too damaged to repair.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: `qpdf exited with code ${exitCode}; produced ${data.length} bytes.`,
    });
  }

  onProgress?.({ stage: "Saving", ratio: 1 });
  const blob = new Blob([new Uint8Array(data)], { type: "application/pdf" });

  // Suffix the basename so a repaired copy sits beside the original rather than
  // shadowing it (e.g. "report.pdf" → "report-repaired.pdf"). We reuse the shared
  // filename helper to strip the source extension, then append the suffix + .pdf.
  const base = replaceExtension(file.name, "").replace(/\.$/, "");

  return {
    blob,
    filename: `${base}-repaired.pdf`,
    mimeType: "application/pdf",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const repairPdfDescriptor: ConversionDescriptor = {
  id: "repair-pdf",
  fromLabel: "PDF",
  toLabel: "Repaired PDF",
  accept: ["application/pdf"],
  newExtension: "pdf",
  controls: [
    {
      // Opt-in, default OFF: also rewrite the repaired file web-optimized
      // (linearized) so it can start rendering before the whole file downloads.
      type: "checkbox",
      id: "linearize",
      label: "Optimize for web (linearize)",
      help: "Optional: also rewrite the repaired PDF so it can start displaying before it has fully downloaded.",
      default: false,
    },
  ],
  // Warm the self-hosted qpdf glue before convert so the one-time load shows as a
  // "setting up" step rather than stalling the first repair.
  loadEngine: async () => {
    await loadQpdf();
  },
  setupSizeLabel: "≈ 1.3 MB",
  convert: convertRepairPdf,
};
