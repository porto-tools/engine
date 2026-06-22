import { describe, it, expect } from "vitest";
import { removeVocalsDescriptor, buildRemoveVocalsArgs } from "./remove-vocals";

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The remove-vocals pipeline requires the @ffmpeg/ffmpeg ST runtime, which spawns
// a Web Worker and loads its core via blob: URLs — none of which exist in plain
// Node. So the happy path and DECODE_FAILED are skipped via it.skipIf, mirroring
// the sibling audio tests. UNSUPPORTED_INPUT and CANCELLED both throw BEFORE any
// FFmpeg call, so they run for real.
const ffmpegRuntimeAvailable =
  typeof Worker !== "undefined" &&
  typeof URL !== "undefined" &&
  typeof URL.createObjectURL === "function";

describe("buildRemoveVocalsArgs", () => {
  it("emits the exact karaoke pan filter and libmp3lame 192k output (locked)", () => {
    // Lock the filter string AND the full argv — this is the load-bearing
    // center-channel cancellation. c0=c0-c1, c1=c1-c0 subtracts the opposite
    // channel from each, cancelling center-panned (vocal) content.
    expect(buildRemoveVocalsArgs("input.mp3", "output.mp3")).toEqual([
      "-i", "input.mp3",
      "-af", "pan=stereo|c0=c0-c1|c1=c1-c0",
      "-c:a", "libmp3lame",
      "-b:a", "192k",
      "output.mp3",
    ]);
  });

  it("passes the filenames through verbatim", () => {
    expect(buildRemoveVocalsArgs("input.flac", "output.mp3")).toEqual([
      "-i", "input.flac",
      "-af", "pan=stereo|c0=c0-c1|c1=c1-c0",
      "-c:a", "libmp3lame",
      "-b:a", "192k",
      "output.mp3",
    ]);
  });
});

describe("removeVocalsDescriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(removeVocalsDescriptor.id).toBe("remove-vocals");
    expect(removeVocalsDescriptor.fromLabel).toBe("Stereo audio");
    expect(removeVocalsDescriptor.toLabel).toBe("Instrumental (MP3)");
    expect(removeVocalsDescriptor.newExtension).toBe("mp3");
    expect(typeof removeVocalsDescriptor.loadEngine).toBe("function");
    expect(removeVocalsDescriptor.setupSizeLabel).toMatch(/24/);
    // No interactive controls — it auto-converts on drop.
    expect(removeVocalsDescriptor.controls).toBeUndefined();
    // Accepts a broad sweep of audio MIME types.
    expect(removeVocalsDescriptor.accept).toContain("audio/mpeg");
    expect(removeVocalsDescriptor.accept).toContain("audio/flac");
    expect(removeVocalsDescriptor.accept).toContain("audio/ogg");
  });

  it("rejects a non-audio file as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "notes.txt", {
      type: "text/plain",
    });
    await expect(removeVocalsDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects an empty-MIME file with a non-audio extension as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3])], "document.pdf", { type: "" });
    await expect(removeVocalsDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED (before engine load)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0xff, 0xfb])], "song.mp3", { type: "audio/mpeg" });
    await expect(
      removeVocalsDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("accepts an empty-MIME file with a known audio extension past the MIME gate", async () => {
    // Passes the MIME gate; aborts before engine load → CANCELLED proves it got past.
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0xff, 0xfb])], "song.flac", { type: "" });
    await expect(
      removeVocalsDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // TODO(test-env): needs the real FFmpeg ST runtime (Worker + blob: URLs + served
  // public/ cores); skipped in the Node test env, mirroring the sibling audio tests.
  it.skipIf(!ffmpegRuntimeAvailable)(
    "removes vocals from a real stereo file (happy path)",
    async () => {
      await removeVocalsDescriptor.loadEngine!();
      const bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
      const file = new File([bytes], "song.mp3", { type: "audio/mpeg" });
      const result = await removeVocalsDescriptor.convert({ file });
      expect(result.mimeType).toBe("audio/mpeg");
      expect(result.filename).toBe("song-instrumental.mp3");
      expect(result.outputSize).toBeGreaterThan(0);
      expect(result.inputSize).toBe(file.size);
    },
  );

  it.skipIf(!ffmpegRuntimeAvailable)(
    "throws DECODE_FAILED on corrupt audio bytes",
    async () => {
      await removeVocalsDescriptor.loadEngine!();
      const file = new File([new Uint8Array([0, 0, 0, 0, 0, 0])], "broken.mp3", {
        type: "audio/mpeg",
      });
      await expect(removeVocalsDescriptor.convert({ file })).rejects.toMatchObject({
        code: "DECODE_FAILED",
        recoverable: true,
      });
    },
  );
});
