import { describe, it, expect, vi, beforeEach } from "vitest";
import { oggMp3Descriptor, buildOggMp3Args } from "./ogg-mp3";

// Mock the ffmpeg-core so DECODE_FAILED (non-zero exit / zero-byte output) can be
// exercised in the Node test env without a real Worker/WASM runtime. The mock is
// reset per test; the happy path remains covered by the e2e smoke (Playwright).
vi.mock("./ffmpeg-core", () => ({
  loadFFmpeg: vi.fn(async () => ({ on: vi.fn(), off: vi.fn() })),
  runFFmpeg: vi.fn(async () => ({ data: new Uint8Array(0), exitCode: 1 })),
}));

import { runFFmpeg } from "./ffmpeg-core";

describe("buildOggMp3Args", () => {
  const DEFAULT_ARGS = ["-i", "input.ogg", "-c:a", "libmp3lame", "-b:a", "192k", "output.mp3"];

  it("default opts emit the codec select with no bitrate (auto)", () => {
    expect(buildOggMp3Args()).toEqual(["-i", "input.ogg", "-c:a", "libmp3lame", "output.mp3"]);
    expect(buildOggMp3Args({})).toEqual(["-i", "input.ogg", "-c:a", "libmp3lame", "output.mp3"]);
  });

  it("the descriptor's defaultOptions reproduce the 192k baseline encode", () => {
    expect(buildOggMp3Args(oggMp3Descriptor.defaultOptions)).toEqual(DEFAULT_ARGS);
  });

  it("emits the chosen bitrate as -b:a <n>k", () => {
    expect(buildOggMp3Args({ bitrate: "256k" })).toEqual([
      "-i", "input.ogg", "-c:a", "libmp3lame", "-b:a", "256k", "output.mp3",
    ]);
  });

  it("VBR on maps the bitrate to a libmp3lame -q:a level instead of -b:a", () => {
    expect(buildOggMp3Args({ bitrate: "320k", vbr: true })).toEqual([
      "-i", "input.ogg", "-c:a", "libmp3lame", "-q:a", "0", "output.mp3",
    ]);
  });
});

describe("oggMp3Descriptor", () => {
  beforeEach(() => {
    vi.mocked(runFFmpeg).mockReset();
    vi.mocked(runFFmpeg).mockResolvedValue({ data: new Uint8Array(0), exitCode: 1 });
  });

  it("has the correct descriptor fields", () => {
    expect(oggMp3Descriptor.id).toBe("ogg-to-mp3");
    expect(oggMp3Descriptor.fromLabel).toBe("OGG");
    expect(oggMp3Descriptor.toLabel).toBe("MP3");
    expect(oggMp3Descriptor.newExtension).toBe("mp3");
    expect(oggMp3Descriptor.accept).toContain("audio/ogg");
    expect(oggMp3Descriptor.accept).toContain("application/ogg");
    expect(typeof oggMp3Descriptor.loadEngine).toBe("function");
  });

  it("rejects a non-OGG file as UNSUPPORTED_INPUT (recoverable false)", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(oggMp3Descriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("respects an already-aborted signal as CANCELLED before engine load", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0x4f, 0x67, 0x67, 0x53])], "song.ogg", {
      type: "audio/ogg",
    });
    await expect(
      oggMp3Descriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
    expect(runFFmpeg).not.toHaveBeenCalled();
  });

  it("throws DECODE_FAILED on a non-zero ffmpeg exit / zero-byte output", async () => {
    const file = new File([new Uint8Array([0x4f, 0x67, 0x67, 0x53])], "song.ogg", {
      type: "audio/ogg",
    });
    await expect(oggMp3Descriptor.convert({ file })).rejects.toMatchObject({
      code: "DECODE_FAILED",
      recoverable: false,
    });
    expect(runFFmpeg).toHaveBeenCalledOnce();
  });
});
