// Tests for image-flip. Happy path is guarded by canvasAvailable.
// UNSUPPORTED_INPUT, CANCELLED, and parseFlipAxes are tested unconditionally.
//
// TODO(test-env): remove the skipIf guard once a browser/canvas environment is
// available in CI.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { imageFlipDescriptor, parseFlipAxes } from "./image-flip";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixturePath = (name: string) => join(HERE, "__fixtures__", name);

async function fileFromFixture(name: string, mime: string): Promise<File> {
  const bytes = await readFile(fixturePath(name));
  return new File([bytes], name, { type: mime });
}

const canvasAvailable =
  typeof createImageBitmap === "function" && typeof document !== "undefined";

describe("imageFlipDescriptor", () => {
  it("declares the parameterized descriptor fields", () => {
    expect(imageFlipDescriptor.id).toBe("image-flip");
    expect(imageFlipDescriptor.accept).toEqual(["image/jpeg", "image/png", "image/webp"]);
    expect(imageFlipDescriptor.controls).toHaveLength(1);
    const ctrl = imageFlipDescriptor.controls![0];
    expect(ctrl.type).toBe("toggle-group");
    expect(ctrl.id).toBe("flip");
    expect(imageFlipDescriptor.loadEngine).toBeUndefined();
  });

  // TODO(test-env): run in browser/canvas env.
  it.skipIf(!canvasAvailable)("flips horizontally", async () => {
    const file = await fileFromFixture("tiny.png", "image/png");
    const result = await imageFlipDescriptor.convert({
      file,
      options: { flipHorizontal: true, flipVertical: false },
    });
    expect(result.mimeType).toBe("image/png");
    expect(result.filename).toBe("tiny.png");
    expect(result.outputSize).toBeGreaterThan(0);
  });

  // TODO(test-env): run in browser/canvas env.
  it.skipIf(!canvasAvailable)("re-encodes even when neither axis is set", async () => {
    const file = await fileFromFixture("tiny.png", "image/png");
    const result = await imageFlipDescriptor.convert({
      file,
      options: { flipHorizontal: false, flipVertical: false },
    });
    expect(result.mimeType).toBe("image/png");
    expect(result.outputSize).toBeGreaterThan(0);
  });

  it("rejects unsupported input as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 0, 0, 0])], "fake.bin", {
      type: "application/octet-stream",
    });
    await expect(imageFlipDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = await fileFromFixture("tiny.png", "image/png");
    await expect(
      imageFlipDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });
});

describe("parseFlipAxes", () => {
  it("reads both axes from the fan-out boolean keys", () => {
    expect(parseFlipAxes({ flipHorizontal: true, flipVertical: false })).toEqual({
      horizontal: true,
      vertical: false,
    });
    expect(parseFlipAxes({ flipHorizontal: false, flipVertical: true })).toEqual({
      horizontal: false,
      vertical: true,
    });
    expect(parseFlipAxes({ flipHorizontal: true, flipVertical: true })).toEqual({
      horizontal: true,
      vertical: true,
    });
  });

  it("treats both as off when missing", () => {
    expect(parseFlipAxes(undefined)).toEqual({ horizontal: false, vertical: false });
    expect(parseFlipAxes({})).toEqual({ horizontal: false, vertical: false });
  });

  it("counts only the strict boolean true as on", () => {
    // Non-boolean truthy-looking values must NOT enable an axis.
    expect(parseFlipAxes({ flipHorizontal: "true", flipVertical: 1 })).toEqual({
      horizontal: false,
      vertical: false,
    });
    expect(parseFlipAxes({ flipHorizontal: "false" })).toEqual({
      horizontal: false,
      vertical: false,
    });
  });
});
