// Unlock PDF — remove a known password from a PDF using qpdf-wasm. The user
// supplies the password the file is currently protected with; qpdf decrypts the
// document and writes a copy with no password. Everything runs in the browser
// via the shared qpdf-wasm loader — the password and the file never leave the
// device.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
import { runQpdf, loadQpdf } from "./qpdf";

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ConversionError("Conversion cancelled.", { code: "CANCELLED", recoverable: true });
  }
}

function assertSupported(file: File): void {
  if (file.type !== "application/pdf") {
    throw new ConversionError("This doesn't look like a PDF file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected application/pdf, received "${file.type || "unknown type"}".`,
    });
  }
}

async function convertUnlockPdf(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  // The password may be empty: some PDFs are restricted with only an owner
  // (permissions) password and an empty user password, which qpdf can open and
  // decrypt with no password at all.
  const password = typeof options?.password === "string" ? options.password : "";

  throwIfAborted(signal);
  onProgress?.({ stage: "Removing password" });

  // qpdf --password=<pw> --decrypt in out. --decrypt writes a copy with the
  // encryption removed; a wrong password (or an unencrypted file qpdf refuses)
  // yields a non-zero exit code, which we map to a friendly recoverable error.
  const { exitCode, data } = await runQpdf(
    file,
    (inPath, outPath) => [`--password=${password}`, "--decrypt", inPath, outPath],
    signal,
  );
  throwIfAborted(signal);

  if (exitCode !== 0 || data.length === 0) {
    throw new ConversionError("That password didn't work, or the PDF isn't password-protected.", {
      code: "DECODE_FAILED",
      recoverable: true,
      technical: `qpdf exited with code ${exitCode}; produced ${data.length} bytes.`,
    });
  }

  onProgress?.({ stage: "Saving", ratio: 1 });
  const blob = new Blob([new Uint8Array(data)], { type: "application/pdf" });

  return {
    blob,
    filename: replaceExtension(file.name, "pdf"),
    mimeType: "application/pdf",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

export const unlockPdfDescriptor: ConversionDescriptor = {
  id: "unlock-pdf",
  fromLabel: "PDF",
  toLabel: "Unlocked PDF",
  accept: ["application/pdf"],
  newExtension: "pdf",
  controls: [
    {
      type: "text",
      id: "password",
      label: "Password",
      help: "The password the PDF is currently protected with.",
      default: "",
      placeholder: "Enter the current password",
      maxLength: 128,
    },
  ],
  // Warm the self-hosted qpdf glue before convert so the one-time load shows as a
  // "setting up" step rather than stalling the first unlock.
  loadEngine: async () => {
    await loadQpdf();
  },
  setupSizeLabel: "≈ 1.3 MB",
  convert: convertUnlockPdf,
};
