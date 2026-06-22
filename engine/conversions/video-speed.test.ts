import { describe, it, expect } from "vitest";
import { videoSpeedDescriptor, buildAtempoChain } from "./video-speed";
import { runFFmpeg } from "./ffmpeg-core";
import type { FFmpeg } from "@ffmpeg/ffmpeg";

// porto-tools' vitest.config.ts uses the default Node environment (no browser).
// The video-speed pipeline requires the @ffmpeg/ffmpeg runtime, which:
//   1. spawns a Web Worker (new Worker(new URL("./worker.js", import.meta.url)))
//   2. loads the multi-threaded core via blob: URLs built with @ffmpeg/util's toBlobURL
//   3. uses fetch() of same-origin /ffmpeg-mt/* assets + URL.createObjectURL
//   4. additionally requires crossOriginIsolated (SharedArrayBuffer for pthreads)
// None of Worker / blob: URL fetch / a served public/ / cross-origin isolation
// exist in plain Node.
//
// TODO(test-env): wire up a browser test environment (e.g. vitest browser mode)
// that serves public/ with COOP/COEP headers and supports Worker + blob: URLs so
// the happy path can run in CI. Until then the happy path is skipped via it.skipIf.
// UNSUPPORTED_INPUT and CANCELLED both throw BEFORE any FFmpeg/Worker call, so
// they run for real.
const ffmpegRuntimeAvailable =
  typeof Worker !== "undefined" &&
  typeof URL !== "undefined" &&
  typeof URL.createObjectURL === "function" &&
  typeof globalThis.crossOriginIsolated !== "undefined" &&
  globalThis.crossOriginIsolated === true;

// ── buildAtempoChain unit tests (pure, no FFmpeg) ──────────────────────────
// atempo only accepts [0.5, 2.0]. For values outside that range the chain is
// composed of multiple stages so the product equals the target speed.
describe("buildAtempoChain", () => {
  it("returns a single atempo=0.5 for 0.5× speed", () => {
    expect(buildAtempoChain(0.5)).toBe("atempo=0.5");
  });

  it("returns a single atempo=1.5 for 1.5× speed", () => {
    expect(buildAtempoChain(1.5)).toBe("atempo=1.5");
  });

  it("returns a single atempo=2 for 2× speed", () => {
    expect(buildAtempoChain(2)).toBe("atempo=2");
  });

  it("chains two atempo=2.0 stages for 4× speed (2.0 × 2.0 = 4)", () => {
    expect(buildAtempoChain(4)).toBe("atempo=2.0,atempo=2");
  });

  it("produces a chain whose values are all within [0.5, 2.0]", () => {
    for (const speed of [0.5, 1.5, 2, 4]) {
      const chain = buildAtempoChain(speed);
      for (const stage of chain.split(",")) {
        const val = parseFloat(stage.replace("atempo=", ""));
        expect(val).toBeGreaterThanOrEqual(0.5 - 1e-9);
        expect(val).toBeLessThanOrEqual(2.0 + 1e-9);
      }
    }
  });
});

// ── runFFmpeg detach-safety regression (the change-video-speed bug) ─────────
// @ffmpeg/ffmpeg's writeFile pushes the Uint8Array's backing ArrayBuffer into
// postMessage's transfer list, which DETACHES that buffer in this thread. The
// video-speed tool writes the SAME input twice (an audio-probe pass, then the
// real speed pass), so a single shared buffer threw:
//   "Failed to execute 'postMessage' on 'Worker': ArrayBuffer at index 0 is
//    already detached."
// runFFmpeg must therefore hand writeFile a fresh OWNED copy each call so the
// caller's buffer is never detached and a second call always succeeds.
//
// This fake FFmpeg reproduces the real transfer semantics with structuredClone's
// transfer option, which genuinely detaches the buffer (byteLength → 0) — the
// same observable effect as the worker postMessage transfer.
function makeDetachingFakeFFmpeg(): {
  ffmpeg: FFmpeg;
  writes: number;
  lastWrittenBytes: () => number[] | null;
} {
  const state = { writes: 0, last: null as number[] | null };
  const fake = {
    writeFile: async (_path: string, data: Uint8Array) => {
      state.writes += 1;
      // Snapshot the bytes BEFORE detaching so we can assert they arrived intact.
      state.last = Array.from(data);
      // Mimic @ffmpeg/ffmpeg: transfer (and thus detach) the backing buffer.
      structuredClone(data.buffer, { transfer: [data.buffer] });
      // If runFFmpeg handed us a buffer it still shares with the caller, the
      // caller's view is now detached too — the bug. The owned-copy fix means the
      // buffer detached here belongs only to runFFmpeg.
      return true;
    },
    exec: async () => 0,
    readFile: async () => new Uint8Array([0xaa, 0xbb]),
    deleteFile: async () => true,
  };
  return {
    ffmpeg: fake as unknown as FFmpeg,
    get writes() {
      return state.writes;
    },
    lastWrittenBytes: () => state.last,
  };
}

describe("runFFmpeg detach safety", () => {
  it("does not detach the caller's input buffer", async () => {
    const handle = makeDetachingFakeFFmpeg();
    const input = new Uint8Array([1, 2, 3, 4, 5]);

    await runFFmpeg(handle.ffmpeg, {
      inName: "input.mp4",
      outName: "output.mp4",
      input,
      args: ["-i", "input.mp4", "output.mp4"],
    });

    // The caller's buffer must survive — writeFile detached only runFFmpeg's copy.
    expect(input.buffer.byteLength).toBe(5);
    expect(Array.from(input)).toEqual([1, 2, 3, 4, 5]);
    // And the bytes that reached writeFile matched the caller's bytes.
    expect(handle.lastWrittenBytes()).toEqual([1, 2, 3, 4, 5]);
  });

  it("can be called twice with the SAME input (probe pass + real pass)", async () => {
    const handle = makeDetachingFakeFFmpeg();
    const input = new Uint8Array([9, 8, 7]);

    // First (probe-style) write detaches a copy internally...
    await runFFmpeg(handle.ffmpeg, {
      inName: "input.mp4",
      outName: "-",
      input,
      args: ["-i", "input.mp4", "-f", "null", "-"],
    });

    // ...and a second write of the same Uint8Array must NOT throw "already
    // detached" — this is the exact change-video-speed regression.
    await expect(
      runFFmpeg(handle.ffmpeg, {
        inName: "input.mp4",
        outName: "output.mp4",
        input,
        args: ["-i", "input.mp4", "output.mp4"],
      }),
    ).resolves.toMatchObject({ exitCode: 0 });

    expect(handle.writes).toBe(2);
    expect(input.buffer.byteLength).toBe(3);
  });

  it("isolates a Uint8Array that views a larger shared buffer", async () => {
    const handle = makeDetachingFakeFFmpeg();
    // A view onto the middle of a larger buffer — real .subarray() shape. The
    // real writeFile transfers the WHOLE underlying buffer, so without an owned
    // copy this would detach far more than intended and break the caller.
    const shared = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const view = shared.subarray(2, 5); // [2,3,4], shares `shared.buffer`

    await runFFmpeg(handle.ffmpeg, {
      inName: "input.mp4",
      outName: "output.mp4",
      input: view,
      args: ["-i", "input.mp4", "output.mp4"],
    });

    // The shared buffer (and the view) must be untouched.
    expect(shared.buffer.byteLength).toBe(8);
    expect(Array.from(view)).toEqual([2, 3, 4]);
    // writeFile received exactly the view's 3 bytes, not the whole shared buffer.
    expect(handle.lastWrittenBytes()).toEqual([2, 3, 4]);
  });
});

describe("videoSpeedDescriptor", () => {
  it("has the correct descriptor fields", () => {
    expect(videoSpeedDescriptor.id).toBe("video-speed");
    expect(videoSpeedDescriptor.fromLabel).toBe("MP4");
    expect(videoSpeedDescriptor.newExtension).toBe("mp4");
    expect(videoSpeedDescriptor.accept).toContain("video/mp4");
    expect(typeof videoSpeedDescriptor.loadEngine).toBe("function");
    expect(typeof videoSpeedDescriptor.setupSizeLabel).toBe("string");
    expect(videoSpeedDescriptor.setupSizeLabel).toMatch(/26/);
  });

  it("declares one slider control for speed with the documented stops", () => {
    expect(videoSpeedDescriptor.controls).toHaveLength(1);
    const [ctrl] = videoSpeedDescriptor.controls!;
    expect(ctrl.type).toBe("slider");
    expect(ctrl.id).toBe("speed");
    if (ctrl.type === "slider") {
      // 0.1 steps up to 1.0, then 0.25 steps up to 4.0; 1x is the neutral anchor.
      expect(ctrl.stops).toHaveLength(22);
      expect(ctrl.stops[0]).toBe(0.1);
      expect(ctrl.stops[ctrl.stops.length - 1]).toBe(4);
      expect(ctrl.stops).toContain(1);
      expect(ctrl.anchor).toBe(1);
    }
  });

  it("rejects a non-MP4 file as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "image.png", {
      type: "image/png",
    });
    await expect(videoSpeedDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("rejects an empty-MIME file with a non-MP4 extension as UNSUPPORTED_INPUT", async () => {
    const file = new File([new Uint8Array([0, 1, 2, 3])], "document.pdf", {
      type: "",
    });
    await expect(videoSpeedDescriptor.convert({ file })).rejects.toMatchObject({
      code: "UNSUPPORTED_INPUT",
      recoverable: false,
    });
  });

  it("accepts an empty-MIME .mp4 file past the MIME gate (abort before engine load → CANCELLED)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0x00, 0x00, 0x00, 0x18])], "clip.mp4", {
      type: "",
    });
    await expect(
      videoSpeedDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  it("respects an already-aborted signal as CANCELLED (before engine load)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const file = new File([new Uint8Array([0x00, 0x00, 0x00, 0x18])], "clip.mp4", {
      type: "video/mp4",
    });
    await expect(
      videoSpeedDescriptor.convert({ file, signal: ctrl.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED", recoverable: true });
  });

  // TODO(test-env): needs the real FFmpeg MT runtime (Worker + blob: URLs + served
  // public/ cores with COOP/COEP + crossOriginIsolated). Skipped in the Node test env.
  // Runs the full write → exec → read pipeline (setpts + atempo filter_complex)
  // against a real MP4 fixture when a browser env is wired up.
  // NOTE: verify in browser that:
  //   1. filter_complex with setpts + atempo chain produces a valid MP4 at all 4 speeds
  //   2. no-audio inputs work with the video-only fallback path (omit -map "[a]")
  //   3. 4× speed uses atempo=2.0,atempo=2.0 without ffmpeg error
  it.skipIf(!ffmpegRuntimeAvailable)(
    "changes speed of a real MP4 (happy path)",
    async () => {
      await videoSpeedDescriptor.loadEngine!();

      const mp4Bytes = new Uint8Array([
        0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
      ]);
      const file = new File([mp4Bytes], "clip.mp4", { type: "video/mp4" });

      const result = await videoSpeedDescriptor.convert({
        file,
        options: { speed: "2" },
      });

      expect(result.mimeType).toBe("video/mp4");
      expect(result.filename).toBe("clip.mp4");
      expect(result.outputSize).toBeGreaterThan(0);
      expect(result.inputSize).toBe(file.size);
    },
  );
});
