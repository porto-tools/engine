import { describe, it, expect, vi, beforeEach } from "vitest";
import { flacMp3Descriptor, buildFlacMp3Args } from "./flac-mp3";

// Mock the ffmpeg-core so DECODE_FAILED (non-zero exit / zero-byte output) can be
// exercised in the Node test env without a real Worker/WASM runtime. The mock is
// reset per test; the happy path remains covered by the e2e smoke (Playwright).
vi.mock("./ffmpeg-core", () => ({
  loadFFmpeg: vi.fn(async () => ({ on: vi.fn(), off: vi.fn() })),
  runFFmpeg: vi.fn(async () => ({ data: new Uint8Array(0), exitCode: 1 })),
}));

import { runFFmpeg } from "./ffmpeg-core";

describe("buildFlacMp3Args", () => {
  const DEFAULT_ARGS = ["-i", "input.flac", "-c:a", "libmp3lame", "-b:a", "192k", "output.mp3"];

  it("default opts emit the codec select with no bitrate (auto)", () => {
    expect(buildFlacMp3Args()).toEqual(["-i", "input.flac", "-c:a", "libmp3lame", "output.mp3"]);
    expect(buildFlacMp3Args({})).toEqual(["-i", "input.flac", "-c:a", "libmp3lame", "output.mp3"]);
  });

  it("the descriptor's defaultOptions reproduce the 192k baseline encode", () => {
    expect(buildFlacMp3Args(flacMp3Descriptor.defaultOptions)).toEqual(DEFAULT_ARGS);
  });

  it("emits the chosen bitrate as -b:a <n>k", () => {
    expect(buildFlacMp3Args({ bitrate: "320k" })).toEqual([
      "-i", "input.flac", "-c:a", "libmp3lame", "-b:a", "320k", "output.mp3",
    ]);
  });

  it("VBR on maps the bitrate to a libmp3lame -q:a level instead of -b:a", () => {
    expect(buildFlacMp3Args({ bitrate: "320k", vbr: true })).toEqual([
      "-i", "input.flac", "-c:a", "libmp3lame", "-q:a", "0", "output.mp3",
    ]);
  });
});

describe("flacMp3Descriptor", () => {
  beforeEach(() => {
    vi.mocked(runFFmpeg).mockReset();
    vi.mocked(runFFmpeg).mockResolvedValue({ data: new Uint8Array(0), exitCode: 1 });
  });

  it("has the correct descriptor fields", () => {
    expect(flacMp3Descriptor.id).toBe("flac-to-mp3");
    expect(flacMp3Descriptor.fromLabel).toBe("FLAC");
    expect(flacMp3Descriptor.toLabel).toBe("MP3");
    expect(flacMp3Descriptor.newExtension).toBe("mp3");
    expect(flacMp3Descriptor.accept).toContain("audio/flac");
    expect(flacMp3Descriptor.accept).toContain("audio/x-flac");
    expect(typeof flacMp3Descriptor.loadEngine).toBe("function");
  });

  it("rejects a non-FLAC file as UNSUPPORTED_INPUT (recoverable false)", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(flacMp3Descriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED before engine load", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0x66, 0x4c, 0x61, 0x43])], "song.flac", {
      type: "audio/flac",
    });
    await expect(
      flacMp3Descriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
    // The abort must fire BEFORE the engine ever runs.
    expect(runFFmpeg).not.toHaveBeenCalled();
  });

  it("throws DECODE_FAILED on a non-zero ffmpeg exit / zero-byte output", async () => {
    const file = new File([new Uint8Array([0x66, 0x4c, 0x61, 0x43])], "song.flac", {
      type: "audio/flac",
    });
    await expect(flacMp3Descriptor.convert({ file })).rejects.toMatchObject({
      code: "DECODE_FAILED",
      recoverable: false,
    });
    expect(runFFmpeg).toHaveBeenCalledOnce();
  });
});
