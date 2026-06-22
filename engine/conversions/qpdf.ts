// Shared qpdf-wasm loader for the Protect / Unlock PDF tools (decision 0013).
//
// @neslinesli93/qpdf-wasm ships a single "universal" Emscripten build whose glue
// statically calls require("fs")/require("path") in its (dead-at-runtime) Node
// branch. Bundling it for the browser therefore breaks the build ("Can't resolve
// 'fs'"). So we do NOT import the package through the bundler at all: the glue
// (qpdf.js) and the binary (qpdf.wasm) are both self-hosted into public/qpdf/ by
// copy-qpdf-runtime.mjs, and we load the glue at runtime via a <script> tag — the
// classic way to load an Emscripten MODULARIZE build. That sidesteps the bundler
// entirely (no fs/path resolution) and keeps everything same-origin (no CDN).
//
// The script defines a global factory `Module(opts) => Promise<instance>`. qpdf is
// single-threaded → no SharedArrayBuffer, so /protect-pdf and /unlock-pdf need no
// COOP/COEP. We call the factory per run (a fresh instance), write the input PDF
// into MEMFS, run qpdf to a MEMFS output path, and read the bytes back. A
// non-zero exit (e.g. a wrong password on unlock) is returned to the
// caller to map to a friendly error.

import { ConversionError } from "../types";

const QPDF_GLUE_URL = "/qpdf/qpdf.js";
const QPDF_WASM_URL = "/qpdf/qpdf.wasm";

// Minimal shape of the Emscripten instance we rely on (the package's own .d.ts is
// partial; FS.readFile + WORKERFS mount are what we use).
interface QpdfInstance {
  callMain: (args: string[]) => number;
  FS: {
    mkdir: (path: string) => void;
    writeFile: (path: string, data: Uint8Array) => void;
    readFile: (path: string) => Uint8Array;
    unlink: (path: string) => void;
  };
}

type QpdfFactory = (opts: { locateFile: () => string; noInitialRun?: boolean }) => Promise<QpdfInstance>;

export interface QpdfRunResult {
  data: Uint8Array;
  exitCode: number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ConversionError("Conversion cancelled.", { code: "CANCELLED", recoverable: true });
  }
}

// Inject the self-hosted qpdf glue once and resolve the global factory it defines.
// Cached so concurrent/repeat callers share a single <script> load.
let factoryPromise: Promise<QpdfFactory> | null = null;

export function loadQpdf(): Promise<QpdfFactory> {
  if (factoryPromise) return factoryPromise;
  factoryPromise = new Promise<QpdfFactory>((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new ConversionError("The PDF security engine needs a browser.", {
        code: "ENGINE_LOAD_FAILED",
        recoverable: false,
        technical: "loadQpdf called with no document (non-browser environment).",
      }));
      return;
    }
    const w = window as unknown as { Module?: QpdfFactory };
    if (typeof w.Module === "function") {
      resolve(w.Module);
      return;
    }
    const script = document.createElement("script");
    script.src = QPDF_GLUE_URL;
    script.async = true;
    script.onload = () => {
      const factory = (window as unknown as { Module?: QpdfFactory }).Module;
      if (typeof factory === "function") resolve(factory);
      else {
        factoryPromise = null;
        reject(new ConversionError("We couldn't load the PDF security engine.", {
          code: "ENGINE_LOAD_FAILED",
          recoverable: true,
          technical: "qpdf.js loaded but window.Module was not a function.",
        }));
      }
    };
    script.onerror = () => {
      factoryPromise = null;
      reject(new ConversionError("We couldn't load the PDF security engine.", {
        code: "ENGINE_LOAD_FAILED",
        recoverable: true,
        technical: `Failed to load ${QPDF_GLUE_URL}.`,
      }));
    };
    document.head.appendChild(script);
  });
  return factoryPromise;
}

// Run qpdf over a single input PDF. `buildArgs(inPath, outPath)` returns the full
// qpdf argv (everything after the program name). The input is mounted read-only
// at /in/input.pdf; the output is expected at /out/output.pdf. Returns the output
// bytes (empty on a failed run) plus qpdf's exit code (0 = success).
export async function runQpdf(
  file: File,
  buildArgs: (inPath: string, outPath: string) => string[],
  signal?: AbortSignal,
): Promise<QpdfRunResult> {
  throwIfAborted(signal);

  const createModule = await loadQpdf();
  throwIfAborted(signal);

  const qpdf = await createModule({ locateFile: () => QPDF_WASM_URL, noInitialRun: true });
  throwIfAborted(signal);

  const inPath = "/in/input.pdf";
  const outPath = "/out/output.pdf";

  qpdf.FS.mkdir("/in");
  qpdf.FS.mkdir("/out");
  // Write the input straight into MEMFS. We previously mounted it read-only via
  // WORKERFS, but WORKERFS only works inside a Web Worker (it relies on
  // FileReaderSync); on the main thread the mount aborts the whole module
  // ("Aborted(undefined)"). PDFs handled here are small, so an in-memory copy is
  // cheap and sidesteps the abort entirely.
  const inputBytes = new Uint8Array(await file.arrayBuffer());
  throwIfAborted(signal);
  qpdf.FS.writeFile(inPath, inputBytes);

  let exitCode: number;
  try {
    exitCode = qpdf.callMain(buildArgs(inPath, outPath));
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (typeof status === "number") exitCode = status;
    else {
      throw new ConversionError("The PDF security engine failed on this file.", {
        code: "DECODE_FAILED",
        recoverable: false,
        technical: err instanceof Error ? err.message : String(err),
      });
    }
  }

  let data: Uint8Array = new Uint8Array(0);
  if (exitCode === 0) {
    try {
      data = qpdf.FS.readFile(outPath);
    } catch {
      data = new Uint8Array(0);
    }
  }

  return { data, exitCode };
}
