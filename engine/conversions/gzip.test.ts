// Tests for gzip.ts. Gzip is pure JS (fflate), so every category runs for real in
// Node — no skip-guard. Inputs are inline byte buffers (no committed binaries):
// the engine deals in binary, the tests build that binary directly.

import { describe, it, expect } from "vitest";
import { gunzipSync, strToU8 } from "fflate";
import { gzipDescriptor } from "./gzip";

describe("gzipDescriptor", () => {
  it("compresses a file to .gz that round-trips back to the original bytes", async () => {
    // Repetitive text so DEFLATE has redundancy to exploit and the .gz is smaller.
    const original = "log line one\nlog line two\n".repeat(200);
    const originalBytes = strToU8(original);
    const file = new File([originalBytes], "app.log", { type: "text/plain" });

    const result = await gzipDescriptor.convert({ file });

    expect(result.mimeType).toBe("application/gzip");
    expect(result.outputSize).toBeGreaterThan(0);
    expect(result.inputSize).toBe(file.size);

    // The payload must gunzip back to the EXACT original bytes (lossless).
    const compressed = new Uint8Array(await result.blob.arrayBuffer());
    const restored = gunzipSync(compressed);
    expect(Array.from(restored)).toEqual(Array.from(originalBytes));

    // Repetitive text genuinely compresses.
    expect(result.outputSize).toBeLessThan(result.inputSize);
  });

  it("appends .gz to the original filename (does not replace the extension)", async () => {
    const file = new File([strToU8("a,b,c\n1,2,3\n")], "data.csv", { type: "text/csv" });
    const result = await gzipDescriptor.convert({ file });
    // .gz is added ON TOP of .csv, not in place of it.
    expect(result.filename).toBe("data.csv.gz");
  });

  it("throws CANCELLED when the signal is already aborted", async () => {
    const file = new File([strToU8("hello")], "note.txt", { type: "text/plain" });
    const controller = new AbortController();
    controller.abort();

    await expect(
      gzipDescriptor.convert({ file, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("rejects an empty file as UNSUPPORTED_INPUT (nothing to compress)", async () => {
    const file = new File([], "empty.txt", { type: "text/plain" });
    await expect(gzipDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("losslessly round-trips arbitrary binary bytes", async () => {
    // A non-text byte sequence (incl. 0x00) must survive the round-trip intact.
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 128, 0, 0, 7, 42]);
    const file = new File([bytes], "blob.bin", { type: "application/octet-stream" });

    const result = await gzipDescriptor.convert({ file });
    expect(result.filename).toBe("blob.bin.gz");

    const restored = gunzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    expect(Array.from(restored)).toEqual(Array.from(bytes));
  });
});
