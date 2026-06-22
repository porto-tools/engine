// CSV ↔ JSON. Both directions are pure string transforms — no DOM, no canvas,
// no WASM. PapaParse handles the CSV grammar (RFC 4180 + real-world quirks);
// JSON.parse / JSON.stringify handles the other side. Because there is nothing
// browser-specific, the happy-path tests run in Node without a skip-guard.
//
// Lazy-import: `import('papaparse')` is called inside the convert functions so
// the ~48 kB minified PapaParse bundle lands in the route chunk, not the
// homepage/shared entry. The /check-bundle gate enforces this.
//
// Round-trip contract: CSV → JSON → CSV is lossless only for flat
// array-of-objects (every row is a plain key→string/number mapping, no nesting,
// no arrays-as-cells). JSON → CSV enforces this: any other shape throws
// UNSUPPORTED_INPUT with a clear message. Users dealing with deeply-nested JSON
// need a different tool; we don't silently mangle their data.

import type { ConversionDescriptor, ConversionInput, ConversionResult } from "../types";
import { ConversionError } from "../types";
import { replaceExtension } from "../filename";
// papaparse.d.ts (co-located) provides a minimal ambient declaration so
// TypeScript can type-check the dynamic import without @types/papaparse.
import type * as PapaParseModule from "papaparse";

// cleanup param omitted: string transforms hold no native resources to release on abort.
// Throw the canonical CANCELLED error if the caller aborted. Mirrors png-jpg.ts.
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ConversionError("Conversion cancelled.", {
      code: "CANCELLED",
      recoverable: true,
    });
  }
}

// Lazily load PapaParse. Wrapped so the dynamic import is one point of failure,
// and the error maps to the engine's error vocabulary.
async function loadPapaParse(): Promise<typeof PapaParseModule> {
  try {
    // Dynamic import keeps PapaParse out of the homepage/shared chunk.
    const mod = await import("papaparse");
    // papaparse may export as default (ESM) or as the module itself (CJS).
    // In practice the `parse`/`unparse` functions are always on the namespace.
    return mod;
  } catch (err) {
    throw new ConversionError("Failed to load the CSV parser.", {
      code: "ENGINE_LOAD_FAILED",
      recoverable: true,
      technical: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------- CSV → JSON ----------

async function convertCsvToJson(input: ConversionInput): Promise<ConversionResult> {
  const { file, signal, onProgress } = input;
  throwIfAborted(signal);

  if (!file.type.includes("csv") && file.type !== "" && !file.name.endsWith(".csv")) {
    throw new ConversionError("This doesn't look like a CSV file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected text/csv or application/vnd.ms-excel, received "${file.type || "unknown type"}".`,
    });
  }

  onProgress?.({ stage: "Reading" });
  let text: string;
  try {
    text = await file.text();
  } catch (err) {
    throw new ConversionError("We couldn't read this file — it may be damaged.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }
  throwIfAborted(signal);

  onProgress?.({ stage: "Parsing" });
  const Papa = await loadPapaParse();
  throwIfAborted(signal);

  let result: ReturnType<typeof Papa.parse<Record<string, string>>>;
  try {
    result = Papa.parse<Record<string, string>>(text, {
      header: true,
      dynamicTyping: false, // string fidelity — no silent number coercion
      skipEmptyLines: true,
    });
  } catch (err) {
    throw new ConversionError("We couldn't parse this CSV — the file may be malformed.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }

  // PapaParse collects per-row errors rather than throwing. Fatal errors
  // (empty file, no rows after header) are surfaced here.
  if (result.data.length === 0) {
    const detail = result.errors.length > 0 ? result.errors[0].message : "No data rows found after header.";
    throw new ConversionError("We couldn't parse this CSV — the file appears empty or malformed.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: detail,
    });
  }

  onProgress?.({ stage: "Encoding" });
  const json = JSON.stringify(result.data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  throwIfAborted(signal);

  return {
    blob,
    filename: replaceExtension(file.name, "json"),
    mimeType: "application/json",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

// ---------- JSON → CSV ----------

// Guard that the parsed JSON is an array of flat objects, which is the only
// shape PapaParse.unparse works cleanly with and the only shape that round-trips.
function assertArrayOfObjects(value: unknown): asserts value is Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new ConversionError(
      "This JSON file can't be converted to CSV — it isn't an array of objects.",
      {
        code: "UNSUPPORTED_INPUT",
        recoverable: false,
        technical: `Expected a top-level JSON array, got ${typeof value}. CSV is flat-tabular; only an array of plain objects maps cleanly to rows. Nested objects, arrays-as-values, and top-level scalars are not supported.`,
      },
    );
  }
  if (value.length === 0) {
    throw new ConversionError(
      "This JSON file is an empty array — there are no rows to convert to CSV.",
      {
        code: "UNSUPPORTED_INPUT",
        recoverable: false,
        technical: "Array has zero elements; CSV would contain only headers with no data.",
      },
    );
  }
  const first = value[0];
  if (typeof first !== "object" || first === null || Array.isArray(first)) {
    throw new ConversionError(
      "This JSON file can't be converted to CSV — the array items must be plain objects.",
      {
        code: "UNSUPPORTED_INPUT",
        recoverable: false,
        technical: `Expected array items to be plain objects; first item is ${Array.isArray(first) ? "array" : typeof first}. Nested arrays and scalar arrays are not supported.`,
      },
    );
  }
}

async function convertJsonToCsv(input: ConversionInput): Promise<ConversionResult> {
  const { file, signal, onProgress } = input;
  throwIfAborted(signal);

  if (file.type !== "application/json" && file.type !== "" && !file.name.endsWith(".json")) {
    throw new ConversionError("This doesn't look like a JSON file.", {
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
      technical: `Expected application/json, received "${file.type || "unknown type"}".`,
    });
  }

  onProgress?.({ stage: "Reading" });
  let text: string;
  try {
    text = await file.text();
  } catch (err) {
    throw new ConversionError("We couldn't read this file — it may be damaged.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }
  throwIfAborted(signal);

  onProgress?.({ stage: "Parsing" });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ConversionError("We couldn't parse this JSON — the file may be malformed.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }
  throwIfAborted(signal);

  // Validate shape before loading PapaParse — early rejection for free.
  assertArrayOfObjects(parsed);

  onProgress?.({ stage: "Encoding" });
  const Papa = await loadPapaParse();
  throwIfAborted(signal);

  let csv: string;
  try {
    csv = Papa.unparse(parsed, { header: true });
  } catch (err) {
    throw new ConversionError("We couldn't convert this JSON to CSV.", {
      code: "DECODE_FAILED",
      recoverable: false,
      technical: err instanceof Error ? err.message : String(err),
    });
  }

  const blob = new Blob([csv], { type: "text/csv" });
  throwIfAborted(signal);

  return {
    blob,
    filename: replaceExtension(file.name, "csv"),
    mimeType: "text/csv",
    inputSize: file.size,
    outputSize: blob.size,
  };
}

// ---------- Descriptors ----------

export const csvJsonDescriptor: ConversionDescriptor = {
  id: "csv-to-json",
  fromLabel: "CSV",
  toLabel: "JSON",
  accept: ["text/csv", "application/vnd.ms-excel"],
  newExtension: "json",
  convert: convertCsvToJson,
};

export const jsonCsvDescriptor: ConversionDescriptor = {
  id: "json-to-csv",
  fromLabel: "JSON",
  toLabel: "CSV",
  accept: ["application/json"],
  newExtension: "csv",
  convert: convertJsonToCsv,
};
