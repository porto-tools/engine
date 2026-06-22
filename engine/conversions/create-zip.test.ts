// create-zip tests. fflate is pure JS and File/Blob/arrayBuffer exist in the
// Node test environment, so every test runs for real with tiny inline byte
// buffers as fixtures (no committed binaries). The happy path round-trips the
// archive back through fflate's unzipSync to prove the entries survive intact.

import { describe, it, expect } from "vitest";
import { unzipSync, strToU8, strFromU8 } from "fflate";
import { createZipDescriptor, __test } from "./create-zip";
import { ConversionError } from "../types";

// Build an in-memory File from a string or raw bytes — no disk, no fixtures dir.
function fileOf(name: string, content: string | Uint8Array, type = ""): File {
  const src = typeof content === "string" ? strToU8(content) : content;
  // Copy into a fresh ArrayBuffer-backed Uint8Array so it satisfies BlobPart
  // (fflate's strToU8 returns Uint8Array<ArrayBufferLike>).
  return new File([new Uint8Array(src)], name, { type });
}

describe("createZipDescriptor", () => {
  it("bundles multiple files into a valid zip whose entries round-trip", async () => {
    const a = fileOf("hello.txt", "hello world");
    const b = fileOf("notes.md", "# heading\nbody");
    const c = fileOf("data.bin", new Uint8Array([0, 1, 2, 3, 255, 128]));

    const result = await createZipDescriptor.convert({ file: a, files: [a, b, c] });

    expect(result.mimeType).toBe("application/zip");
    expect(result.filename).toBe("archive.zip");
    expect(result.outputSize).toBeGreaterThan(0);
    expect(result.inputSize).toBe(a.size + b.size + c.size);

    const unzipped = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    expect(Object.keys(unzipped).sort()).toEqual(["data.bin", "hello.txt", "notes.md"]);
    expect(strFromU8(unzipped["hello.txt"])).toBe("hello world");
    expect(strFromU8(unzipped["notes.md"])).toBe("# heading\nbody");
    expect(Array.from(unzipped["data.bin"])).toEqual([0, 1, 2, 3, 255, 128]);
  });

  it("names the archive after the file when only one is given", async () => {
    const only = fileOf("report.csv", "a,b,c\n1,2,3");
    const result = await createZipDescriptor.convert({ file: only, files: [only] });

    expect(result.filename).toBe("report.zip");
    const unzipped = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    expect(Object.keys(unzipped)).toEqual(["report.csv"]);
  });

  it("throws UNSUPPORTED_INPUT when no files are given", async () => {
    const placeholder = fileOf("x.txt", "x");
    await expect(
      createZipDescriptor.convert({ file: placeholder, files: [] }),
    ).rejects.toMatchObject({
      name: "ConversionError",
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("throws CANCELLED when the signal is already aborted", async () => {
    const f = fileOf("a.txt", "a");
    const controller = new AbortController();
    controller.abort();

    const promise = createZipDescriptor.convert({ file: f, files: [f], signal: controller.signal });
    await expect(promise).rejects.toBeInstanceOf(ConversionError);
    await expect(promise).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("disambiguates duplicate filenames so no entry is overwritten", async () => {
    const f1 = fileOf("dup.txt", "first");
    const f2 = fileOf("dup.txt", "second");
    const f3 = fileOf("dup.txt", "third");

    const result = await createZipDescriptor.convert({ file: f1, files: [f1, f2, f3] });
    const unzipped = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));

    expect(Object.keys(unzipped).sort()).toEqual(["dup-2.txt", "dup-3.txt", "dup.txt"]);
    expect(strFromU8(unzipped["dup.txt"])).toBe("first");
    expect(strFromU8(unzipped["dup-2.txt"])).toBe("second");
    expect(strFromU8(unzipped["dup-3.txt"])).toBe("third");
  });

  it("uniqueName suffixes before the extension and leaves dotfiles intact", () => {
    const used = new Set<string>();
    expect(__test.uniqueName("a.txt", used)).toBe("a.txt");
    expect(__test.uniqueName("a.txt", used)).toBe("a-2.txt");
    expect(__test.uniqueName("a.txt", used)).toBe("a-3.txt");
    expect(__test.uniqueName(".env", used)).toBe(".env");
    expect(__test.uniqueName(".env", used)).toBe(".env-2");
  });
});
