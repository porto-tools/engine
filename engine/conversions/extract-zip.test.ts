import { describe, it, expect } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { extractZipDescriptor } from "./extract-zip";

// Build a real .zip in-test with fflate's zipSync, then extract it back. No
// committed binaries — the bytes are constructed inline, the same way the engine
// deals in binary in production.
function makeZip(entries: Record<string, Uint8Array>): File {
  const bytes = zipSync(entries);
  return new File([bytes], "archive.zip", { type: "application/zip" });
}

describe("extractZipDescriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(extractZipDescriptor.id).toBe("extract-zip");
    expect(extractZipDescriptor.fromLabel).toBe("ZIP");
    expect(extractZipDescriptor.toLabel).toBe("Files");
    expect(extractZipDescriptor.outputMode).toBe("multi");
    expect(extractZipDescriptor.accept).toEqual([
      "application/zip",
      "application/x-zip-compressed",
    ]);
    // No WASM engine: fflate is dynamically imported inside convert.
    expect(extractZipDescriptor.loadEngine).toBeUndefined();
  });

  it("extracts every entry with the correct bytes (happy path)", async () => {
    const hello = strToU8("hello world");
    const data = strToU8('{"a":1}');
    const raw = new Uint8Array([0, 1, 2, 3, 255, 254]);
    const file = makeZip({
      "readme.txt": hello,
      "data.json": data,
      "blob.bin": raw,
    });

    const res = await extractZipDescriptor.convert({ file });

    expect(res.outputs).toBeDefined();
    expect(res.outputs).toHaveLength(3);
    expect(res.inputSize).toBe(file.size);

    const byName = new Map(res.outputs!.map((o) => [o.filename, o]));

    const txt = byName.get("readme.txt")!;
    expect(txt.mimeType).toBe("text/plain");
    expect(new Uint8Array(await txt.blob.arrayBuffer())).toEqual(hello);

    const json = byName.get("data.json")!;
    expect(json.mimeType).toBe("application/json");
    expect(new Uint8Array(await json.blob.arrayBuffer())).toEqual(data);

    const bin = byName.get("blob.bin")!;
    expect(bin.mimeType).toBe("application/octet-stream");
    expect(new Uint8Array(await bin.blob.arrayBuffer())).toEqual(raw);

    // The top-level single result mirrors the first output.
    expect(res.outputs![0].filename).toBe(res.filename);
  });

  it("rejects a non-ZIP file as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(extractZipDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects garbage bytes claiming to be a ZIP as DECODE_FAILED", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], "broken.zip", {
      type: "application/zip",
    });
    await expect(extractZipDescriptor.convert({ file })).rejects.toMatchObject({
      code: "DECODE_FAILED",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED (before any work)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = makeZip({ "readme.txt": strToU8("hi") });
    await expect(
      extractZipDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("skips directory entries and sanitises path-traversal names to basenames", async () => {
    // fflate emits a directory entry for names ending in "/". The traversal and
    // absolute-path entries must be reduced to a safe basename with no path
    // components, so two leaf "secret.txt" entries collide and get de-duped.
    const file = makeZip({
      "folder/": new Uint8Array(0),
      "folder/nested.txt": strToU8("nested"),
      "../../etc/passwd": strToU8("root"),
      "/abs/secret.txt": strToU8("one"),
      "deep/dir/secret.txt": strToU8("two"),
    });

    const res = await extractZipDescriptor.convert({ file });
    const names = res.outputs!.map((o) => o.filename).sort();

    // The "folder/" directory entry is dropped; every other entry is reduced to
    // its basename. No name contains a slash or ".." segment.
    expect(names).not.toContain("folder/");
    for (const n of names) {
      expect(n).not.toMatch(/[\\/]/);
      expect(n).not.toContain("..");
    }
    // "passwd", "nested.txt", and two "secret.txt" leaves (one de-duped).
    expect(names).toEqual(["nested.txt", "passwd", "secret (2).txt", "secret.txt"]);
  });
});
