// Protect PDF — password-encrypt a PDF with AES-256 using qpdf-wasm. The user
// supplies an open (user) password and, optionally, a separate owner password
// plus a set of permission flags (printing, copying, editing, annotations, form
// filling, accessibility extraction, document assembly). qpdf encrypts the
// document at 256-bit AES strength. Everything runs in the browser via the
// shared qpdf-wasm loader — the passwords and the file never leave the device.
//
// qpdf version: the self-hosted binary is qpdf 11.7.0 (the version string baked
// into public/qpdf/qpdf.wasm; ships via @neslinesli93/qpdf-wasm 0.3.0). That
// build's `--help=encryption` confirms every flag below, the modern
// `--encrypt user owner key-length [options] --` positional form, and that
// `full` is the default print level — so the default argv here reproduces the
// old "no restriction flags = all allowed" behavior. We map each UI toggle
// straight onto its own per-permission flag rather than the coarser --modify=
// levels:
//   --print=full|low|none   printing resolution
//   --extract=y|n           text/graphics copy & extraction
//   --modify-other=y|n      general content modification
//   --annotate=y|n          comments / annotations (and signing)
//   --form=y|n              filling in form fields
//   --accessibility=y|n     extraction for accessibility
//   --assemble=y|n          document assembly (insert/rotate/delete pages)
// A checkbox that is ON (the default) = the action is ALLOWED → emit "=y"; OFF =
// restricted → emit "=n". We always emit every flag explicitly so the produced
// permissions are deterministic and independent of qpdf's implied-flag chaining.

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

// The printing levels qpdf accepts for --print under 256-bit encryption. Anything
// the UI sends that isn't one of these is clamped back to "full" (allow all) so a
// stray value can never silently lock printing down.
const PRINT_LEVELS = ["full", "low", "none"] as const;
type PrintLevel = (typeof PRINT_LEVELS)[number];

function readPrintLevel(value: unknown): PrintLevel {
  return (PRINT_LEVELS as readonly string[]).includes(value as string)
    ? (value as PrintLevel)
    : "full";
}

// Each permission checkbox defaults to ON = allowed. We read it defensively:
// only an explicit `false` restricts the action; missing/garbage options leave
// the permission allowed, matching the "default everything on" UI.
function isAllowed(value: unknown): boolean {
  return value !== false;
}

// Turn the option bag into qpdf's restriction argv (the flags that sit between
// the 256 key-length and the closing "--"). Pure + defensive: it never throws and
// always returns explicit y/n for every permission so the result is deterministic.
function buildRestrictionFlags(options: ConversionInput["options"]): string[] {
  const yn = (allowed: boolean): "y" | "n" => (allowed ? "y" : "n");
  return [
    `--print=${readPrintLevel(options?.printing)}`,
    `--extract=${yn(isAllowed(options?.allowCopy))}`,
    `--modify-other=${yn(isAllowed(options?.allowModify))}`,
    `--annotate=${yn(isAllowed(options?.allowAnnotate))}`,
    `--form=${yn(isAllowed(options?.allowForm))}`,
    `--accessibility=${yn(isAllowed(options?.allowAccessibility))}`,
    `--assemble=${yn(isAllowed(options?.allowAssembly))}`,
  ];
}

async function convertProtectPdf(input: ConversionInput): Promise<ConversionResult> {
  const { file, options, signal, onProgress } = input;
  throwIfAborted(signal);
  assertSupported(file);

  const password = typeof options?.password === "string" ? options.password : "";
  // A blank open password can't encrypt anything — surface a recoverable prompt so
  // the user just types one in and retries, rather than treating it as a bad file.
  if (password.trim().length === 0) {
    throw new ConversionError("Enter a password to protect the PDF.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: true,
    });
  }

  // The owner password is optional. Blank → reuse the open password, so the single
  // password both opens the file and governs permissions (the original behavior).
  // A distinct owner password lets the user keep the permission settings locked
  // behind a separate secret while sharing only the open password.
  const ownerRaw = typeof options?.ownerPassword === "string" ? options.ownerPassword : "";
  const ownerPassword = ownerRaw.length > 0 ? ownerRaw : password;

  const restrictionFlags = buildRestrictionFlags(options);

  throwIfAborted(signal);
  onProgress?.({ stage: "Encrypting" });

  // qpdf --encrypt <user-pw> <owner-pw> 256 <restriction flags> -- in out.
  // 256 selects AES-256; the restriction flags disable the permissions the user
  // turned off. Everything after "--" is qpdf's positional in/out file pair.
  const { data, exitCode } = await runQpdf(
    file,
    (inPath, outPath) => [
      "--encrypt",
      password,
      ownerPassword,
      "256",
      ...restrictionFlags,
      "--",
      inPath,
      outPath,
    ],
    signal,
  );
  throwIfAborted(signal);

  if (exitCode !== 0 || data.length === 0) {
    throw new ConversionError("We couldn't protect this PDF. It may be damaged or already encrypted.", {
      code: "DECODE_FAILED",
      recoverable: false,
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

export const protectPdfDescriptor: ConversionDescriptor = {
  id: "protect-pdf",
  fromLabel: "PDF",
  toLabel: "Protected PDF",
  accept: ["application/pdf"],
  newExtension: "pdf",
  controls: [
    {
      type: "text",
      id: "password",
      label: "Open password",
      help: "Password to open the PDF. It never leaves your device.",
      default: "",
      placeholder: "Choose a password",
      maxLength: 128,
    },
    {
      type: "text",
      id: "ownerPassword",
      label: "Owner password (optional)",
      help: "Optional separate password to change permissions. Leave blank to reuse the open password.",
      default: "",
      placeholder: "Reuse open password",
      maxLength: 128,
    },
    {
      type: "select",
      id: "printing",
      label: "Printing",
      help: "Whether the PDF can be printed, and at what quality.",
      default: "full",
      options: [
        { value: "full", label: "Allow" },
        { value: "low", label: "Low-res only" },
        { value: "none", label: "Disallow" },
      ],
    },
    {
      type: "checkbox",
      id: "allowCopy",
      label: "Allow copying / extraction",
      help: "Let readers copy or extract text and graphics.",
      default: true,
    },
    {
      type: "checkbox",
      id: "allowModify",
      label: "Allow editing / modification",
      help: "Let readers change the document's content.",
      default: true,
    },
    {
      type: "checkbox",
      id: "allowAnnotate",
      label: "Allow annotations / comments",
      help: "Let readers add comments, annotations, and signatures.",
      default: true,
    },
    {
      type: "checkbox",
      id: "allowForm",
      label: "Allow form filling",
      help: "Let readers fill in form fields.",
      default: true,
    },
    {
      type: "checkbox",
      id: "allowAccessibility",
      label: "Allow accessibility extraction",
      help: "Let assistive software extract text. Usually best left on.",
      default: true,
    },
    {
      type: "checkbox",
      id: "allowAssembly",
      label: "Allow document assembly",
      help: "Let readers insert, rotate, or delete pages.",
      default: true,
    },
  ],
  // Warm the self-hosted qpdf glue before convert so the one-time load shows as a
  // "setting up" step rather than stalling the first encrypt.
  loadEngine: async () => {
    await loadQpdf();
  },
  setupSizeLabel: "≈ 1.3 MB",
  convert: convertProtectPdf,
};
